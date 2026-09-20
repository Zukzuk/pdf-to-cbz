/**
 * convertFolderOfPdfs.js
 *
 * Build:
docker build -t pdf-converter .
 *
 * Run:
docker run --rm -v "C:/HostTemp:/tmp" -v "C:\Users\davet\Downloads:/inPdfs" -v "C:\Users\davet\Downloads:/outCbz" pdf-converter node convertFolderOfPdfs.js "/inPdfs" "/outCbz"
 *
 * Or simply: docker compose run --rm converter
 *
 * Steps:
 *   1) Reads all .pdf files in <INPUT_PDF_FOLDER>.
 *   2) For each PDF:
 *      - Convert all pages to .jpg in a subfolder named after the PDF (without extension).
 *        Pages are scaled proportionally (never stretched) and each output image's
 *        aspect ratio is checked against its source page; a mismatch fails the PDF.
 *      - Zip that subfolder into a .cbz file in <OUTPUT_PDF_FOLDER>.
 *   3) Logs each page as it finishes, so progress is visible in real time.
 */

const fs = require("fs");
const path = require("path");
const { fromPath } = require("pdf2pic");
const archiver = require("archiver");
const gm = require("gm").subClass({ imageMagick: false }); // same GraphicsMagick pdf2pic uses

// Pages are scaled proportionally so BOTH dimensions end up at least this size
// (never stretched: a 2:3 page stays 2:3, a landscape spread stays wide).
const MIN_WIDTH = 1200;
const MIN_HEIGHT = 1600;
const DENSITY = 150;            // render resolution; higher = sharper but slower
const JPEG_QUALITY = 80;
const CONCURRENCY = 4;          // pages converted at once
const ASPECT_TOLERANCE = 0.005; // max relative aspect-ratio error (0.5%) vs. the source page

// 1) Parse CLI arguments
const [,, inputFolder, baseOutputDir] = process.argv;

if (!inputFolder || !baseOutputDir) {
  console.error("\nUsage: node convertFolderOfPdfs.js <INPUT_PDF_FOLDER> <OUTPUT_FOLDER>\n");
  process.exit(1);
}

// 2) Gather all PDF files from the input folder
if (!fs.existsSync(inputFolder)) {
  console.error(`\n❌ The input folder does not exist: ${inputFolder}\n`);
  process.exit(1);
}

// Make sure the output folder exists
if (!fs.existsSync(baseOutputDir)) {
  fs.mkdirSync(baseOutputDir, { recursive: true });
}

const allFiles = fs.readdirSync(inputFolder);
const pdfFiles = allFiles.filter(file => file.toLowerCase().endsWith(".pdf"));

if (pdfFiles.length === 0) {
  console.log(`\nNo PDF files found in folder: ${inputFolder}\n`);
  process.exit(0);
}

console.log(`\nFound ${pdfFiles.length} PDF(s) in "${inputFolder}"`);
console.log(`Output folder: "${baseOutputDir}"`);

// 3) Main async wrapper to process sequentially (to keep logs simple)
(async function processPdfs() {
  let index = 0;
  for (const pdfFile of pdfFiles) {
    index++;
    try {
      const pdfPath = path.join(inputFolder, pdfFile);
      console.log(`\n--- [${index}/${pdfFiles.length}] Starting PDF: "${pdfFile}" ---`);
      await convertPdfToCbz(pdfPath, baseOutputDir);
      console.log(`--- Finished PDF: "${pdfFile}" ---\n`);
    } catch (err) {
      console.error(`\n❌ ERROR processing PDF "${pdfFile}":`, err, "\n");
    }
  }
  console.log("\n✅ All PDFs processed.\n");
})();

/**
 * convertPdfToCbz
 * ---------------
 * Converts a single PDF to a series of images in a subfolder, then zips that subfolder to a .cbz file.
 */
async function convertPdfToCbz(pdfFilePath, baseOutputDir) {
  const pdfName = path.basename(pdfFilePath, path.extname(pdfFilePath));
  const outputSubfolder = path.join(baseOutputDir, pdfName);

  console.log(`  → Creating subfolder: ${outputSubfolder}`);
  if (!fs.existsSync(outputSubfolder)) {
    fs.mkdirSync(outputSubfolder, { recursive: true });
  }

  console.log(`  → Reading page sizes from PDF: ${pdfFilePath}`);
  const sourcePages = await identifyPdfPages(pdfFilePath);
  console.log(`  → ${sourcePages.length} pages to convert`);

  const convert = fromPath(pdfFilePath, {
    density: DENSITY,
    saveFilename: pdfName,
    savePath: outputSubfolder,
    format: "jpg",
    quality: JPEG_QUALITY,
    // Without this pdf2pic force-resizes every page to exactly width x height
    // (GraphicsMagick "!"), stretching any page that isn't that shape.
    preserveAspectRatio: true,
    width: MIN_WIDTH,
    height: MIN_HEIGHT
  });

  await convertPages(convert, sourcePages);
  console.log(`  → Converted ${sourcePages.length} pages.`);

  // Create .cbz file named after the PDF
  const cbzFileName = `${pdfName}.cbz`;
  const cbzFilePath = path.join(baseOutputDir, cbzFileName);

  console.log(`  → Creating CBZ: ${cbzFilePath}`);
  await zipFolder(outputSubfolder, cbzFilePath);

  console.log(`  → CBZ created: ${cbzFilePath}`);

  // (Optional) Remove the unzipped images if you only need the CBZ
  console.log(`  → Removing folder: ${outputSubfolder}`);
  fs.rmSync(outputSubfolder, { recursive: true, force: true });
}

/**
 * identifyPdfPages
 * ----------------
 * Returns [{ page, width, height }] for every page of the PDF (page is 1-based).
 */
function identifyPdfPages(pdfFilePath) {
  return new Promise((resolve, reject) => {
    gm(pdfFilePath).identify("%p|%w|%h\n", (err, out) => {
      if (err) return reject(err);
      const pages = String(out)
        .split("\n")
        .filter(Boolean)
        .map(line => {
          const [page, width, height] = line.split("|").map(Number);
          return { page, width, height };
        });
      if (pages.length === 0 || pages.some(p => !(p.page > 0 && p.width > 0 && p.height > 0))) {
        return reject(new Error(`Could not read page sizes from PDF: ${JSON.stringify(out)}`));
      }
      resolve(pages);
    });
  });
}

/**
 * imageSize
 * ---------
 * Returns the real pixel size of a rendered image.
 * (pdf2pic's own "size" field just echoes the requested width x height, so it can't be trusted.)
 */
function imageSize(imagePath) {
  return new Promise((resolve, reject) => {
    gm(imagePath).size((err, size) => (err ? reject(err) : resolve(size)));
  });
}

/**
 * convertPages
 * ------------
 * Converts each page (CONCURRENCY at a time), verifies its aspect ratio against the
 * source page, and logs it the moment it finishes.
 */
async function convertPages(convert, sourcePages) {
  const total = sourcePages.length;
  const started = Date.now();
  let done = 0;
  let next = 0;

  async function worker() {
    while (next < total) {
      const src = sourcePages[next++];
      const res = await convert(src.page);
      const out = await imageSize(res.path);

      const srcRatio = src.width / src.height;
      const outRatio = out.width / out.height;
      const error = Math.abs(outRatio - srcRatio) / srcRatio;
      if (error > ASPECT_TOLERANCE) {
        throw new Error(
          `Page ${src.page} aspect ratio changed: source ${src.width}x${src.height} ` +
          `(${srcRatio.toFixed(4)}) -> output ${out.width}x${out.height} (${outRatio.toFixed(4)})`
        );
      }

      done++;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `  → Page ${src.page}/${total} done (${done}/${total} complete, ${secs}s) ` +
        `${src.width}x${src.height} -> ${out.width}x${out.height}`
      );
    }
  }

  // If any worker throws, Promise.all rejects and the PDF is reported as failed;
  // `next = total` stops the remaining workers from starting more pages.
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, total) }, () =>
      worker().catch(err => { next = total; throw err; })
    )
  );
}

/**
 * zipFolder
 * ---------
 * Zips an entire folder using `archiver` and saves it to outputZipPath.
 */
async function zipFolder(folderPath, outputZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      console.log(`    ZIP size: ${archive.pointer()} bytes`);
      resolve();
    });

    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    // "false" => place the folder contents directly in the archive root
    archive.directory(folderPath, false);
    archive.finalize();
  });
}

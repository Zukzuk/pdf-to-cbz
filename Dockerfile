# Use the official Node.js LTS image
FROM node:22

# Install GraphicsMagick or ImageMagick
RUN apt-get update && apt-get install -y graphicsmagick && rm -rf /var/lib/apt/lists/*

# Create an app directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your code
COPY . .

# By default, run a simple command (but we'll override this in `docker run`)
CMD ["node", "convertPdfToJpegs.js"]

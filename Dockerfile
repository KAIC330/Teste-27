FROM node:18-alpine

WORKDIR /app

# Copy package manifests and install dependencies (reproducible)
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the application code
# We copy everything because the server serves static files from ../
COPY . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server/server.js"]

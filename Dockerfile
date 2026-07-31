FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io postgresql-client curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY server.js .
CMD ["node", "server.js"]

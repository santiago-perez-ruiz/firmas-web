# syntax=docker/dockerfile:1
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/datos

WORKDIR /app

# Las dependencias primero: esta capa se reutiliza si solo cambia el codigo.
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

# La base de datos y los PNG de las firmas viven en el volumen, no en la imagen.
RUN mkdir -p /datos && chown -R node:node /datos /app
USER node
VOLUME ["/datos"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

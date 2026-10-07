FROM node:24-alpine
# tesseract OCR for receipt scanning (eng traineddata only, stays lean)
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]

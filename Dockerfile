# Stage 1: Build frontend
FROM node:20-alpine AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --production=false
COPY web/ .
RUN npm run build

# Stage 2: Build Go backend
FROM golang:1.25-alpine AS backend
RUN apk add --no-cache gcc musl-dev
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY server/ ./server/
COPY --from=frontend /app/web/dist ./web/dist
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o /app/server ./server/

# Stage 3: Runtime
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

COPY --from=backend /app/server .
COPY --from=backend /app/web/dist ./web/dist

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV PORT=3000
ENV DB_PATH=/app/data/omnia.db
ENV AUDIO_PATH=/music
ENV INDEX_PATH=/music/index.json
ENV JWT_SECRET=change-this-in-production

EXPOSE 3000

VOLUME ["/music", "/app/data"]

CMD ["./server"]

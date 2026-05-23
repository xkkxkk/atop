# ── Stage 1: build ──────────────────────────────────────────────────────
FROM golang:1.23-alpine AS builder

# Alpine 换阿里云镜像（apk 不走国外）
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache git ca-certificates tzdata

# Go 模块走国内代理，跳过 checksum DB（sum.golang.org 也在国外）
ENV GOPROXY=https://goproxy.cn,https://goproxy.io,direct
ENV GONOSUMDB=*
ENV GONOPROXY=
ENV GOFLAGS=-mod=mod

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-w -s" -o atop-backend ./cmd/server

# ── Stage 2: runtime ────────────────────────────────────────────────────
FROM alpine:3.20

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates tzdata wget
WORKDIR /app

COPY --from=builder /build/atop-backend .
COPY .env.example .env.example

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["./atop-backend"]

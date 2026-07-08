FROM rust:alpine AS backend
WORKDIR /home/rust/src
RUN apk --no-cache add musl-dev openssl-dev
COPY . .
# Cache the cargo registry + target dir so edits to non-Rust files (e.g. the
# frontend) don't trigger a full recompile. Copy the binary out of the cached
# target dir since cache mounts aren't part of the layer filesystem.
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=rustpad-cargo-reg \
    --mount=type=cache,target=/home/rust/src/target,id=rustpad-target \
    cargo build --release && cp target/release/rustpad-server /rustpad-server

FROM --platform=amd64 rust:alpine AS wasm
WORKDIR /home/rust/src
RUN apk --no-cache add curl musl-dev
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=rustpad-cargo-reg \
    --mount=type=cache,target=/home/rust/src/target,id=rustpad-wasm-target \
    wasm-pack build rustpad-wasm

FROM --platform=amd64 node:lts-alpine AS frontend
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
COPY --from=wasm /home/rust/src/rustpad-wasm/pkg rustpad-wasm/pkg
RUN npm install
COPY . .
ARG GITHUB_SHA
ENV VITE_SHA=${GITHUB_SHA}
RUN npm run check
RUN npm run build

FROM scratch
COPY --from=frontend /usr/src/app/dist dist
COPY --from=backend /rustpad-server .
USER 1000:1000
CMD [ "./rustpad-server" ]

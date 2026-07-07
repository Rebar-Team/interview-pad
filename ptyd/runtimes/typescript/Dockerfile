# Offline TypeScript runtime for InterviewPad: tsx preinstalled so `.ts` files
# run with no network at execution time. Built on the box as interview-pad-ts:local.
FROM node:22-bookworm-slim
RUN npm install -g tsx@4.19.2 && npm cache clean --force
WORKDIR /code

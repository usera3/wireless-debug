FROM node:22-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json* ./
RUN npm install
COPY index.html .
COPY src ./src
ARG VITE_API_BASE_URL=http://localhost:8080
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /workspace/dist /usr/share/nginx/html
EXPOSE 80

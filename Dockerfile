FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* bun.lockb* bun.lock* ./
RUN npm install --no-audit --no-fund --legacy-peer-deps
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID=local
ARG VITE_PUBLIC_APP_URL
ARG VITE_APP_BASE_PATH=/
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID
ENV VITE_PUBLIC_APP_URL=$VITE_PUBLIC_APP_URL
ENV VITE_APP_BASE_PATH=$VITE_APP_BASE_PATH
RUN npm run build -- --mode selfhosted

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

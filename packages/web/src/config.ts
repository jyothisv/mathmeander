// Build-time configuration (Vite env). Defaults match .env.example / compose.
export const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:8787';
export const DEV_IDP_ORIGIN = import.meta.env.VITE_DEV_IDP_ORIGIN ?? 'http://localhost:8788';

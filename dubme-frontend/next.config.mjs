/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow API origin to be configured per-env without rebuilding.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
  },
};

export default nextConfig;

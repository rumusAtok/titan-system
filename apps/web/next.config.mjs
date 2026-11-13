/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pure static export: the application is HTML/JS served by nginx and talks
  // only to the API gateway. There is no server-side rendering tier to secure.
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@mimir/ui", "@mimir/shared-types"],
};

export default nextConfig;

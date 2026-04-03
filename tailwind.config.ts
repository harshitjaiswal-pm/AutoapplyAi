import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Our brand colors - navy + blue, matching the PRD
        navy: "#1B2A4A",
        brand: {
          50: "#EBF2FF",
          100: "#D5E8F0",
          500: "#2E75B6",
          600: "#245F96",
          700: "#1B4A77",
        },
      },
    },
  },
  plugins: [],
};
export default config;

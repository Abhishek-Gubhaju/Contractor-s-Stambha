// Vite resolves static assets to URLs at build time; TypeScript needs to know
// the shape of those imports.
declare module '*.svg' {
  const url: string;
  export default url;
}

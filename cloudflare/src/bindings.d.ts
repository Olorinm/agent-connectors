declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./index');
    durableNamespaces: 'TrustedReader';
  }
}

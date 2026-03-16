declare module 'qrcode-terminal' {
  export function generate(text: string, options?: { small?: boolean }): void;
  export function generate(text: string, options: { small?: boolean }, callback: (qr: string) => void): void;
}

/**
 * 同梱した Web アプリの index.html を、VS Code の webview 用に書き換える (純粋関数)
 * - 相対パスの資産 (./assets/..., ./favicon.svg) を webview の URI にする
 * - CSP を入れる (スクリプトは同梱分と nonce 付きのインラインだけ。フォントは Google Fonts を許す)
 * Input : html = dist/index.html の中身, toUri = 相対パスを webview の URI 文字列にする関数, cspSource = webview.cspSource, nonce
 * Output: 書き換えた HTML
 */
export function rewriteIndexHtml(html: string, toUri: (rel: string) => string, cspSource: string, nonce: string): string {
  let out = html.replace(/(src|href)="\.\/([^"]+)"/g, (_m, attr: string, rel: string) => `${attr}="${toUri(rel)}"`);
  // インラインのスクリプト (テーマの先読み) に nonce を付ける
  out = out.replace(/<script>/g, `<script nonce="${nonce}">`);
  const csp = [
    "default-src 'none'"
  , `img-src ${cspSource} data: blob:`
  , `style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com`
  , `font-src ${cspSource} https://fonts.gstatic.com data:`
  , `script-src ${cspSource} 'nonce-${nonce}'`
  , "connect-src 'none'"
  ].join("; ");
  out = out.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
  return out;
}

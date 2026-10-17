/** node:http の代替 (Workers)。serve (手元の HTTP サーバー) は使えない。型だけを満たす */
const unavailable = (name: string) => () => { throw new Error(`${name} is not available in the hosted environment`); };
export const createServer = unavailable("createServer");
export const request = unavailable("request");
export class IncomingMessage {}
export class ServerResponse {}
export class Server {}
export default { createServer, request };

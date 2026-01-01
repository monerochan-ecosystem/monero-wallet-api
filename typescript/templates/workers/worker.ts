import { workerMainCodeToBase64 } from '../inlineMacro' with { type: 'macro' };
const source = workerMainCodeToBase64()
export const workerMainCode = new TextDecoder().decode(new Uint8Array(atob(source).split("").map(function(c) {
    return c.charCodeAt(0); })));
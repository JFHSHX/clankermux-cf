// 统一使用全局 crypto (Workers 内置 WebCrypto)
export const crypto = globalThis.crypto;
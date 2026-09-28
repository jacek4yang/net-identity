/**
 * Local type augmentation for parts of the Firefox WebExtension API surface that
 * `@types/firefox-webext-browser` (143.0.0) does not declare.
 *
 * The package declares the `browser.proxy` namespace, `settings` and `onRequest`,
 * but it omits `ProxyInfo` — the object a `proxy.onRequest` listener must return.
 * Declaring it here keeps the proxy engine fully typed instead of relying on
 * unchecked casts.
 *
 * These are only the fields net-identity actually produces. Firefox additionally
 * accepts `connectionIsolationKey` and, on newer builds, the `masque` proxy type.
 *
 * Remove this file once the upstream types include `ProxyInfo`.
 */
declare namespace browser.proxy {
  interface ProxyInfo {
    type: "direct" | "http" | "https" | "socks" | "socks4";
    host?: string;
    port?: number;
    /** SOCKS only. Firefox rejects credentials on HTTP/HTTPS proxy info. */
    username?: string;
    /** SOCKS only. */
    password?: string;
    /** SOCKS and SOCKS4 only. */
    proxyDNS?: boolean;
    failoverTimeout?: number;
    /** Preemptive `Proxy-Authorization` value (HTTP/HTTPS proxies). */
    proxyAuthorizationHeader?: string;
  }

  /** What a `proxy.onRequest` listener may return. */
  type ProxyOnRequestResult = ProxyInfo | Array<ProxyInfo | null> | null;
}

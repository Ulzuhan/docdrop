/** Route parameters validated by Go and embedded in the root element. */
export function routeParams(): { id: string; token: string } {
  const data = document.getElementById("app")?.dataset;
  return { id: data?.fileId ?? "", token: data?.guestToken ?? "" };
}

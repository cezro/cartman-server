// Integer centavos for display, written the way the apps write them
// (`Peso.format` in cartman-mobile's packages/core/lib/src/models/money.dart):
// `₱1,250.00`, grouped. A refusal this server words is shown to the customer
// verbatim, beside amounts the app formatted, so the two have to agree.
export function formatPeso(centavos: bigint): string {
  const pesos = (centavos / 100n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (centavos % 100n).toString().padStart(2, '0');
  return `₱${pesos}.${cents}`;
}

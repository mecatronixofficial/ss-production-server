export function processBalance(inputKg: number, outputKg: number, wasteKg = 0, rejectedKg = 0) {
  return inputKg - outputKg - wasteKg - rejectedKg;
}

export function orderPending(orderKg: number, deliveredKg: number, cancelledKg = 0) {
  return Math.max(0, orderKg - deliveredKg - cancelledKg);
}

export function stockBalance(quantityIn: number, quantityOut: number) {
  return quantityIn - quantityOut;
}

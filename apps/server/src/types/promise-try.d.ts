// pi-web-access optionally imports promise.try without shipping or depending on its types.
declare module "promise.try" {
  const promiseTry: { shim(): void };
  export default promiseTry;
}

// The running host provides this legacy alias. Resolve it to the public SDK in Node tests.
export function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@bb/plugin-sdk" ? "@get-bb/plugin-sdk" : specifier === "@bb/plugin-sdk/app" ? "@get-bb/plugin-sdk/app" : specifier, context);
}

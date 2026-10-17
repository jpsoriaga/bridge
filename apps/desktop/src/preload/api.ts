/** Everything the renderer can reach in the main world, as `window.bridge`. Keep it minimal. */
export interface BridgeApi {
  readonly version: string;
}

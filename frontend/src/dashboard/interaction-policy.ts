export type ChartInteractionPolicy = {
  cursorPin: boolean;
  dragZoom: boolean;
  pan: boolean;
  panModifier: "shift" | undefined;
  pinchZoom: boolean;
  policyName: "desktop-analysis" | "inspect" | "mobile-scroll";
  wheelZoom: boolean;
};

export function chartInteractionPolicy({
  inspect,
  mobile,
}: {
  inspect: boolean;
  mobile: boolean;
}): ChartInteractionPolicy {
  if (inspect) {
    return {
      cursorPin: true,
      dragZoom: !mobile,
      pan: true,
      panModifier: mobile ? undefined : "shift",
      pinchZoom: true,
      policyName: "inspect",
      wheelZoom: true,
    };
  }
  if (mobile) {
    return {
      cursorPin: false,
      dragZoom: false,
      pan: false,
      panModifier: undefined,
      pinchZoom: false,
      policyName: "mobile-scroll",
      wheelZoom: false,
    };
  }
  return {
    cursorPin: true,
    dragZoom: true,
    pan: true,
    panModifier: "shift",
    pinchZoom: true,
    policyName: "desktop-analysis",
    wheelZoom: true,
  };
}

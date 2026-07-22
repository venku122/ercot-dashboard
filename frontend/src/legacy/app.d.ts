declare global {
  interface Window {
    __ercotChartLifecycle?: {
      constructed: number;
      destroyed: number;
      updated: number;
    };
    __ercotLongTasks?: number[];
  }
}

export {};

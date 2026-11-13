'use client';

import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, CanvasRenderer]);

export const PALETTE = ['#0369a1', '#b45309', '#15803d', '#7c3aed', '#be123c', '#0f766e', '#a16207', '#475569'];

/**
 * Thin Apache ECharts wrapper. `label` is the accessible name of the chart;
 * the figures behind every chart are also available as text or tables on the page.
 */
export function Chart({ option, height = 280, label }: { option: echarts.EChartsCoreOption; height?: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const instance = echarts.init(ref.current);
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption({ color: PALETTE, textStyle: { fontFamily: 'inherit' }, ...option }, { notMerge: true });
  }, [option]);

  // The accessible name lives on the wrapper; the canvas ECharts draws into is presentational.
  return (
    <div role="img" aria-label={label}>
      <div ref={ref} aria-hidden="true" style={{ height, width: '100%' }} />
    </div>
  );
}

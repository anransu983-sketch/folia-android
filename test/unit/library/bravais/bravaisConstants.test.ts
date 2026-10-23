import { describe, expect, it } from 'vitest';
import {
    BRAVAIS_CULL_EDGE_MARGIN,
    BRAVAIS_CULL_EDGE_MARGIN_NARROW,
    BRAVAIS_CULL_EDGE_MARGIN_NARROW_PERFORMANCE,
    BRAVAIS_CULL_EDGE_MARGIN_PERFORMANCE,
    BRAVAIS_OVERSCAN,
    BRAVAIS_OVERSCAN_NARROW,
    BRAVAIS_OVERSCAN_NARROW_PERFORMANCE,
    BRAVAIS_OVERSCAN_PERFORMANCE,
    getBravaisCullEdgeMargin,
    getBravaisOverscan,
} from '../../../../src/library/suites/bravais/bravaisConstants';

// test/unit/library/bravais/bravaisConstants.test.ts
// 墙的预渲染分档：默认档是真机调出来的数（窄屏扩到 1100 防拖动露白），一个都不能动；
// 性能模式档只许收小，且余量必须小于预渲染 —— 相机 padding = 两者之差，为负时永远在重裁。

const NARROW_WIDTH = 412;
const WIDE_WIDTH = 1280;

describe('bravais wall metrics', () => {
    it('keeps the tuned default tiers untouched', () => {
        expect(getBravaisOverscan(NARROW_WIDTH)).toBe(BRAVAIS_OVERSCAN_NARROW);
        expect(getBravaisOverscan(WIDE_WIDTH)).toBe(BRAVAIS_OVERSCAN);
        expect(getBravaisCullEdgeMargin(NARROW_WIDTH)).toBe(BRAVAIS_CULL_EDGE_MARGIN_NARROW);
        expect(getBravaisCullEdgeMargin(WIDE_WIDTH)).toBe(BRAVAIS_CULL_EDGE_MARGIN);
        // Passing the flag explicitly as false is the same as not passing it.
        expect(getBravaisOverscan(NARROW_WIDTH, false)).toBe(BRAVAIS_OVERSCAN_NARROW);
        expect(getBravaisCullEdgeMargin(WIDE_WIDTH, false)).toBe(BRAVAIS_CULL_EDGE_MARGIN);
    });

    it('shrinks both tiers under performance mode', () => {
        expect(getBravaisOverscan(NARROW_WIDTH, true)).toBe(BRAVAIS_OVERSCAN_NARROW_PERFORMANCE);
        expect(getBravaisOverscan(WIDE_WIDTH, true)).toBe(BRAVAIS_OVERSCAN_PERFORMANCE);
        expect(getBravaisCullEdgeMargin(NARROW_WIDTH, true)).toBe(BRAVAIS_CULL_EDGE_MARGIN_NARROW_PERFORMANCE);
        expect(getBravaisCullEdgeMargin(WIDE_WIDTH, true)).toBe(BRAVAIS_CULL_EDGE_MARGIN_PERFORMANCE);
        expect(BRAVAIS_OVERSCAN_NARROW_PERFORMANCE).toBeLessThan(BRAVAIS_OVERSCAN_NARROW);
        expect(BRAVAIS_OVERSCAN_PERFORMANCE).toBeLessThan(BRAVAIS_OVERSCAN);
    });

    it('keeps the cull margin below the overscan in every tier, so the camera padding stays positive', () => {
        for (const width of [NARROW_WIDTH, WIDE_WIDTH]) {
            for (const performanceMode of [false, true]) {
                expect(getBravaisOverscan(width, performanceMode))
                    .toBeGreaterThan(getBravaisCullEdgeMargin(width, performanceMode));
            }
        }
    });
});

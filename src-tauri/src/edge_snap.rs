use crate::window_geometry::Bounds;

const CAPTURE_DIP: f64 = 24.0;
const RELEASE_DIP: f64 = 36.0;

#[derive(Clone, Copy)]
enum Side {
    Start,
    End,
}

/// One native drag session. Track the original grab point instead of adding
/// mouse deltas to an already snapped window, which can trap slow drags.
#[derive(Clone, Copy)]
pub struct Drag {
    grab_x: f64,
    grab_y: f64,
    area: Option<Bounds>,
    horizontal: Option<Side>,
    vertical: Option<Side>,
}

impl Drag {
    pub fn begin(bounds: Bounds, cursor: (i32, i32)) -> Self {
        Self {
            grab_x: (f64::from(cursor.0) - f64::from(bounds.x)) / f64::from(bounds.width.max(1)),
            grab_y: (f64::from(cursor.1) - f64::from(bounds.y)) / f64::from(bounds.height.max(1)),
            area: None,
            horizontal: None,
            vertical: None,
        }
    }

    /// Preserve the relative grab point when Windows changes size across DPI.
    pub fn proposed(&self, cursor: (i32, i32), width: u32, height: u32) -> Bounds {
        Bounds {
            x: (f64::from(cursor.0) - self.grab_x * f64::from(width)).round() as i32,
            y: (f64::from(cursor.1) - self.grab_y * f64::from(height)).round() as i32,
            width,
            height,
        }
    }

    pub fn snap(&mut self, proposed: Bounds, area: Bounds, scale: f64) -> Bounds {
        if self.area != Some(area) {
            self.horizontal = None;
            self.vertical = None;
            self.area = Some(area);
        }
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let capture = (CAPTURE_DIP * scale).round() as i64;
        let release = (RELEASE_DIP * scale).round() as i64;
        Bounds {
            x: snap_axis(
                proposed.x,
                proposed.width,
                area.x,
                area.width,
                capture,
                release,
                &mut self.horizontal,
            ),
            y: snap_axis(
                proposed.y,
                proposed.height,
                area.y,
                area.height,
                capture,
                release,
                &mut self.vertical,
            ),
            ..proposed
        }
    }
}

fn snap_axis(
    position: i32,
    length: u32,
    start: i32,
    span: u32,
    capture: i64,
    release: i64,
    held: &mut Option<Side>,
) -> i32 {
    // Do not resize or clamp oversized windows during a move.
    if length > span || span == 0 {
        *held = None;
        return position;
    }
    let start = i64::from(start);
    let end = start + i64::from(span - length);
    let position = i64::from(position);
    let target = |side| match side {
        Side::Start => start,
        Side::End => end,
    };
    if let Some(side) = *held {
        if (position - target(side)).abs() <= release {
            return target(side) as i32;
        }
    }
    let side = if (position - start).abs() <= (position - end).abs() {
        Side::Start
    } else {
        Side::End
    };
    if (position - target(side)).abs() <= capture {
        *held = Some(side);
        target(side) as i32
    } else {
        *held = None;
        position as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const AREA: Bounds = Bounds {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    const WINDOW: Bounds = Bounds {
        x: 500,
        y: 200,
        width: 360,
        height: 560,
    };

    fn snap(x: i32, y: i32) -> Bounds {
        Drag::begin(WINDOW, (600, 220)).snap(Bounds { x, y, ..WINDOW }, AREA, 1.0)
    }

    #[test]
    fn captures_all_four_edges_and_corners_without_resizing() {
        for (input, output) in [
            ((23, 200), (0, 200)),
            ((1540, 200), (1560, 200)),
            ((500, 24), (500, 0)),
            ((500, 460), (500, 480)),
            ((23, 20), (0, 0)),
            ((1540, 460), (1560, 480)),
            ((-20, 200), (0, 200)),
        ] {
            assert_eq!(
                snap(input.0, input.1),
                Bounds {
                    x: output.0,
                    y: output.1,
                    ..WINDOW
                }
            );
        }
        assert_eq!(snap(500, 200), WINDOW);
        assert_eq!(snap(25, 200).x, 25);
        assert_eq!(snap(-25, 200).x, -25);
    }

    #[test]
    fn slow_one_pixel_steps_release_in_both_directions_without_sticking() {
        for sign in [-1, 1] {
            let start = Bounds { x: 0, ..WINDOW };
            let mut drag = Drag::begin(start, (100, 220));
            for distance in 0..=60 {
                let raw = drag.proposed((100 + sign * distance, 220), 360, 560);
                let fitted = drag.snap(raw, AREA, 1.0);
                assert_eq!(fitted.x, if distance <= 36 { 0 } else { sign * distance });
            }
        }
    }

    #[test]
    fn small_jitter_stays_snapped_until_release_then_recaptures() {
        let mut drag = Drag::begin(WINDOW, (600, 220));
        for (raw, expected) in [
            (24, 0),
            (25, 0),
            (23, 0),
            (36, 0),
            (37, 37),
            (30, 30),
            (24, 0),
        ] {
            assert_eq!(
                drag.snap(Bounds { x: raw, ..WINDOW }, AREA, 1.0).x,
                expected
            );
        }
    }

    #[test]
    fn negative_monitor_and_scaled_work_area_include_taskbar_offset() {
        let area = Bounds {
            x: -1920,
            y: -1040,
            ..AREA
        };
        let mut drag = Drag::begin(WINDOW, (600, 220));
        let raw = Bounds {
            x: -382,
            y: -1010,
            ..WINDOW
        };
        assert_eq!(
            drag.snap(raw, area, 1.5),
            Bounds {
                x: -360,
                y: -1040,
                ..WINDOW
            }
        );
        let area = Bounds {
            x: 48,
            width: 1872,
            ..AREA
        };
        assert_eq!(drag.snap(Bounds { x: 60, ..WINDOW }, area, 1.0).x, 48);
    }

    #[test]
    fn changing_monitor_clears_old_edge_latch() {
        let mut drag = Drag::begin(WINDOW, (600, 220));
        drag.snap(Bounds { x: 0, ..WINDOW }, AREA, 1.0);
        let second = Bounds { x: -1920, ..AREA };
        assert_eq!(drag.snap(Bounds { x: -390, ..WINDOW }, second, 1.0).x, -390);
    }

    #[test]
    fn oversized_window_can_be_dragged_freely_on_oversized_axis() {
        let mut drag = Drag::begin(WINDOW, (600, 220));
        let raw = Bounds {
            x: 10,
            y: 10,
            width: 2000,
            ..WINDOW
        };
        assert_eq!(drag.snap(raw, AREA, 1.0), Bounds { y: 0, ..raw });
    }

    #[test]
    fn grab_point_scales_when_windows_changes_dpi() {
        let drag = Drag::begin(WINDOW, (600, 220));
        assert_eq!(
            drag.proposed((-800, 100), 540, 840),
            Bounds {
                x: -950,
                y: 70,
                width: 540,
                height: 840
            }
        );
    }
}

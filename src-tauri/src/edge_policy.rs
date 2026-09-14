use crate::window_geometry::Bounds;
use serde::Serialize;
use std::time::{Duration, Instant};

pub const HIDE_DELAY: Duration = Duration::from_millis(800);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Right,
    Left,
    Top,
    Bottom,
}

pub fn nearest_edge(window: Bounds, area: Bounds, threshold: u32) -> Option<Edge> {
    let right = i64::from(window.x) + i64::from(window.width);
    let bottom = i64::from(window.y) + i64::from(window.height);
    let area_right = i64::from(area.x) + i64::from(area.width);
    let area_bottom = i64::from(area.y) + i64::from(area.height);
    if right <= i64::from(area.x)
        || bottom <= i64::from(area.y)
        || i64::from(window.x) >= area_right
        || i64::from(window.y) >= area_bottom
    {
        return None;
    }
    // Stable tie breaking makes the default top-right dock retract to the right.
    [
        (Edge::Right, (area_right - right).max(0)),
        (Edge::Left, (i64::from(window.x) - i64::from(area.x)).max(0)),
        (Edge::Top, (i64::from(window.y) - i64::from(area.y)).max(0)),
        (Edge::Bottom, (area_bottom - bottom).max(0)),
    ]
    .into_iter()
    .filter(|(_, distance)| *distance <= i64::from(threshold))
    .min_by_key(|(_, distance)| *distance)
    .map(|(edge, _)| edge)
}

pub fn handle_bounds(window: Bounds, area: Bounds, edge: Edge, scale: f64) -> Bounds {
    let thickness = (24.0 * scale).round().max(1.0) as u32;
    let length = (64.0 * scale).round().max(1.0) as u32;
    let vertical = matches!(edge, Edge::Left | Edge::Right);
    let width = if vertical { thickness } else { length }.min(area.width);
    let height = if vertical { length } else { thickness }.min(area.height);
    let max_x = i64::from(area.x) + i64::from(area.width - width);
    let max_y = i64::from(area.y) + i64::from(area.height - height);
    let x = match edge {
        Edge::Left => i64::from(area.x),
        Edge::Right => max_x,
        _ => i64::from(window.x) + (i64::from(window.width) - i64::from(width)) / 2,
    };
    let y = match edge {
        Edge::Top => i64::from(area.y),
        Edge::Bottom => max_y,
        _ => i64::from(window.y) + (i64::from(window.height) - i64::from(height)) / 2,
    };
    Bounds {
        x: x.clamp(i64::from(area.x), max_x) as i32,
        y: y.clamp(i64::from(area.y), max_y) as i32,
        width,
        height,
    }
}

pub fn contains(bounds: Bounds, x: f64, y: f64, padding: f64) -> bool {
    x >= f64::from(bounds.x) - padding
        && y >= f64::from(bounds.y) - padding
        && x < f64::from(bounds.x) + f64::from(bounds.width) + padding
        && y < f64::from(bounds.y) + f64::from(bounds.height) + padding
}

#[derive(Default)]
pub struct CollapseDelay {
    outside_since: Option<Instant>,
    last_bounds: Option<Bounds>,
}

impl CollapseDelay {
    pub fn reset(&mut self) {
        self.outside_since = None;
    }

    pub fn ready(&mut self, bounds: Bounds, eligible: bool, now: Instant) -> bool {
        if self.last_bounds != Some(bounds) || !eligible {
            self.last_bounds = Some(bounds);
            self.reset();
            return false;
        }
        let outside_since = *self.outside_since.get_or_insert(now);
        now.saturating_duration_since(outside_since) >= HIDE_DELAY
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
        x: 1544,
        y: 16,
        width: 360,
        height: 560,
    };

    #[test]
    fn recognizes_all_edges_and_prefers_right_at_top_right() {
        assert_eq!(nearest_edge(WINDOW, AREA, 28), Some(Edge::Right));
        assert_eq!(
            nearest_edge(
                Bounds {
                    x: 0,
                    y: 150,
                    ..WINDOW
                },
                AREA,
                28
            ),
            Some(Edge::Left)
        );
        assert_eq!(
            nearest_edge(
                Bounds {
                    x: 400,
                    y: 0,
                    ..WINDOW
                },
                AREA,
                28
            ),
            Some(Edge::Top)
        );
        assert_eq!(
            nearest_edge(
                Bounds {
                    x: 400,
                    y: 480,
                    ..WINDOW
                },
                AREA,
                28
            ),
            Some(Edge::Bottom)
        );
        assert_eq!(
            nearest_edge(
                Bounds {
                    x: 400,
                    y: 150,
                    ..WINDOW
                },
                AREA,
                28
            ),
            None
        );
        assert_eq!(nearest_edge(Bounds { x: 2100, ..WINDOW }, AREA, 28), None);
    }

    #[test]
    fn uses_physical_coordinates_with_negative_monitor_origins_and_dpi() {
        let area = Bounds {
            x: -1920,
            y: -1080,
            ..AREA
        };
        let window = Bounds {
            x: -576,
            y: -1056,
            width: 540,
            height: 840,
        };
        assert_eq!(nearest_edge(window, area, 42), Some(Edge::Top));
        let handle = handle_bounds(window, area, Edge::Right, 1.5);
        assert_eq!(handle.width, 36);
        assert_eq!(handle.height, 96);
        assert_eq!(handle.x, -36);
        assert!(contains(handle, -18.0, f64::from(handle.y + 20), 0.0));
    }

    #[test]
    fn arrow_stays_inside_the_work_area_for_every_edge() {
        for edge in [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom] {
            let handle = handle_bounds(
                Bounds {
                    x: -80,
                    y: 900,
                    ..WINDOW
                },
                AREA,
                edge,
                2.0,
            );
            assert!(handle.x >= AREA.x && handle.y >= AREA.y);
            assert!(handle.x as u32 + handle.width <= AREA.width);
            assert!(handle.y as u32 + handle.height <= AREA.height);
        }
    }

    #[test]
    fn partially_crossing_an_edge_still_retracts_to_that_edge() {
        assert_eq!(
            nearest_edge(
                Bounds {
                    x: -120,
                    y: 150,
                    ..WINDOW
                },
                AREA,
                28
            ),
            Some(Edge::Left)
        );
        assert_eq!(
            nearest_edge(
                Bounds {
                    x: 1800,
                    y: 150,
                    ..WINDOW
                },
                AREA,
                28
            ),
            Some(Edge::Right)
        );
    }

    #[test]
    fn returning_to_window_or_pinning_cancels_pending_collapse() {
        let mut delay = CollapseDelay::default();
        let now = Instant::now();
        assert!(!delay.ready(WINDOW, true, now));
        assert!(!delay.ready(WINDOW, true, now + Duration::from_millis(100)));
        assert!(!delay.ready(WINDOW, true, now + Duration::from_millis(700)));
        assert!(!delay.ready(WINDOW, false, now + Duration::from_millis(800)));
        assert!(!delay.ready(WINDOW, true, now + Duration::from_millis(1000)));
        assert!(delay.ready(WINDOW, true, now + Duration::from_millis(1800)));
    }

    #[test]
    fn moving_or_resizing_restarts_the_delay() {
        let mut delay = CollapseDelay::default();
        let now = Instant::now();
        delay.ready(WINDOW, true, now);
        delay.ready(WINDOW, true, now);
        let moved = Bounds { y: 50, ..WINDOW };
        assert!(!delay.ready(moved, true, now + Duration::from_secs(2)));
        assert!(!delay.ready(moved, true, now + Duration::from_secs(2)));
        assert!(!delay.ready(
            Bounds {
                height: 600,
                ..moved
            },
            true,
            now + Duration::from_secs(4)
        ));
    }

    #[test]
    fn arrow_hover_zone_bridges_the_gap_to_the_expanded_window() {
        let handle = handle_bounds(WINDOW, AREA, Edge::Right, 1.0);
        let pointer = (1910.0, f64::from(handle.y + 32));
        assert!(!contains(WINDOW, pointer.0, pointer.1, 0.0));
        assert!(contains(handle, pointer.0, pointer.1, 0.0));
    }
}

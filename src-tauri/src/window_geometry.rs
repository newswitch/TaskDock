#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn fit(current: Bounds, area: Bounds, margin: u32, dock: bool) -> Bounds {
    let width = current.width.min(area.width);
    let height = current.height.min(area.height);
    let right = i64::from(area.x) + i64::from(area.width - width);
    let bottom = i64::from(area.y) + i64::from(area.height - height);
    let (x, y) = if dock {
        (
            right - i64::from(margin),
            i64::from(area.y) + i64::from(margin),
        )
    } else {
        (i64::from(current.x), i64::from(current.y))
    };
    Bounds {
        x: x.clamp(i64::from(area.x), right) as i32,
        y: y.clamp(i64::from(area.y), bottom) as i32,
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const AREA: Bounds = Bounds {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
    };

    #[test]
    fn keeps_an_entirely_visible_window_unchanged() {
        let current = Bounds {
            x: 100,
            y: 90,
            width: 360,
            height: 560,
        };
        assert_eq!(fit(current, AREA, 16, false), current);
    }

    #[test]
    fn brings_the_bottom_and_right_edges_back_into_the_work_area() {
        let current = Bounds {
            x: 1200,
            y: 500,
            width: 360,
            height: 560,
        };
        assert_eq!(
            fit(current, AREA, 16, false),
            Bounds {
                x: 920,
                y: 160,
                ..current
            }
        );
    }

    #[test]
    fn shrinks_a_window_restored_from_a_larger_display() {
        let current = Bounds {
            x: 1800,
            y: 100,
            width: 1600,
            height: 1200,
        };
        assert_eq!(fit(current, AREA, 16, false), AREA);
        assert_eq!(fit(current, AREA, 16, true), AREA);
    }

    #[test]
    fn docks_on_a_negative_origin_monitor_with_a_scaled_margin() {
        let area = Bounds {
            x: -1920,
            y: -1080,
            width: 1920,
            height: 1040,
        };
        let current = Bounds {
            x: 100,
            y: 100,
            width: 540,
            height: 840,
        };
        assert_eq!(
            fit(current, area, 24, true),
            Bounds {
                x: -564,
                y: -1056,
                ..current
            }
        );
    }
}

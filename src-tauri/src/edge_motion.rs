use crate::edge_policy::Edge;
use serde::Serialize;
use std::time::{Duration, Instant};

// The frontend runs a short compositor animation. This is a recovery deadline,
// not a frame timer: a lost completion must never leave a window stuck halfway.
pub const DEADLINE: Duration = Duration::from_millis(900);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Show,
    Hide,
    Reset,
    Park,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Request {
    pub id: u64,
    pub phase: Phase,
    pub edge: Edge,
    #[serde(skip)]
    started: Instant,
}

impl Request {
    pub fn expired(self, now: Instant) -> bool {
        now.saturating_duration_since(self.started) >= DEADLINE
    }
}

#[derive(Default)]
pub struct Motions {
    generation: u64,
    pending: Option<Request>,
}

impl Motions {
    pub fn start(&mut self, phase: Phase, edge: Edge, now: Instant) -> Request {
        self.generation += 1;
        let request = Request {
            id: self.generation,
            phase,
            edge,
            started: now,
        };
        self.pending = matches!(phase, Phase::Show | Phase::Hide).then_some(request);
        request
    }
    pub fn pending(&self) -> Option<Request> {
        self.pending
    }
    pub fn complete(&mut self, id: u64) -> Option<Request> {
        if self.pending.is_some_and(|motion| motion.id == id) {
            self.pending.take()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returning_during_hide_invalidates_the_old_completion() {
        let mut motions = Motions::default();
        let now = Instant::now();
        let hide = motions.start(Phase::Hide, Edge::Right, now);
        let show = motions.start(Phase::Show, Edge::Right, now);
        assert!(motions.complete(hide.id).is_none());
        assert_eq!(motions.pending().unwrap().phase, Phase::Show);
        assert_eq!(motions.complete(show.id).unwrap().phase, Phase::Show);
        assert!(motions.complete(show.id).is_none());
    }

    #[test]
    fn tray_hide_or_reset_cancels_pending_callbacks() {
        let mut motions = Motions::default();
        let now = Instant::now();
        let show = motions.start(Phase::Show, Edge::Top, now);
        let reset = motions.start(Phase::Reset, Edge::Top, now);
        assert!(reset.id > show.id);
        assert!(motions.pending().is_none());
        assert!(motions.complete(show.id).is_none());
    }

    #[test]
    fn recovery_deadline_is_bounded_and_uses_the_latest_transition() {
        let mut motions = Motions::default();
        let now = Instant::now();
        let hide = motions.start(Phase::Hide, Edge::Left, now);
        assert!(!hide.expired(now + Duration::from_millis(899)));
        assert!(hide.expired(now + DEADLINE));
        let show = motions.start(Phase::Show, Edge::Left, now + DEADLINE);
        assert!(!show.expired(now + DEADLINE));
        assert!(motions.complete(hide.id).is_none());
    }
}

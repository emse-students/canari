// Says a recurring sentence ONCE per subject, then only at each power of ten of its count.
//
// The gateway's copy of chat-delivery's `RepeatCounter` (`utils/log-repeat.ts`): a line that can
// fire on every frame a client sends is reporting a RATE, and a rate is not read one line at a time.
// The first occurrence carries the whole sentence; the 10th, 100th, 1000th carry the count. No clock
// decides anything - only the count does.

use std::collections::HashMap;
use std::sync::Mutex;

/// Per-process occurrence counts keyed by subject, bounded by `max_subjects`: past it the whole map
/// is forgotten and a recurring subject simply says its sentence again - the conservative direction.
pub struct RepeatCounter {
    counts: Mutex<HashMap<String, u64>>,
    max_subjects: usize,
}

impl RepeatCounter {
    /// A counter remembering at most `max_subjects` subjects.
    pub fn new(max_subjects: usize) -> Self {
        Self {
            counts: Mutex::new(HashMap::new()),
            max_subjects,
        }
    }

    /// Counts one occurrence for `subject`, returning its ordinal when it should be printed (1, 10,
    /// 100, ...) and `None` otherwise.
    pub fn hit(&self, subject: &str) -> Option<u64> {
        let mut counts = self.counts.lock().unwrap_or_else(|p| p.into_inner());
        if !counts.contains_key(subject) && counts.len() >= self.max_subjects {
            counts.clear();
        }
        let n = counts.entry(subject.to_string()).or_insert(0);
        *n += 1;
        is_power_of_ten(*n).then_some(*n)
    }

    /// Forgets `subject`: its next occurrence is said as the first of a new episode. What ends an
    /// episode is a FACT its caller knows (the refused thing was accepted again), never a delay.
    pub fn forget(&self, subject: &str) {
        self.counts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(subject);
    }
}

/// True for 1, 10, 100, ...
fn is_power_of_ten(n: u64) -> bool {
    let mut x = n;
    while x >= 10 && x.is_multiple_of(10) {
        x /= 10;
    }
    x == 1
}

#[cfg(test)]
mod tests {
    use super::RepeatCounter;

    #[test]
    fn a_forgotten_subject_is_said_again_as_the_first() {
        let counter = RepeatCounter::new(10);
        assert_eq!(counter.hit("s"), Some(1));
        assert_eq!(counter.hit("s"), None);
        assert_eq!(counter.hit("other"), Some(1));

        counter.forget("s");

        assert_eq!(counter.hit("s"), Some(1));
        assert_eq!(counter.hit("other"), None);
    }

    #[test]
    fn prints_the_first_then_each_power_of_ten() {
        let counter = RepeatCounter::new(10);
        let printed: Vec<u64> = (0..1000).filter_map(|_| counter.hit("s")).collect();
        assert_eq!(printed, vec![1, 10, 100, 1000]);
    }

    #[test]
    fn subjects_count_apart() {
        let counter = RepeatCounter::new(10);
        assert_eq!(counter.hit("a"), Some(1));
        assert_eq!(counter.hit("b"), Some(1));
        assert_eq!(counter.hit("a"), None);
    }

    #[test]
    fn a_full_map_forgets_and_says_the_sentence_again() {
        let counter = RepeatCounter::new(1);
        assert_eq!(counter.hit("a"), Some(1));
        assert_eq!(counter.hit("a"), None);
        assert_eq!(counter.hit("b"), Some(1));
        assert_eq!(counter.hit("a"), Some(1));
    }
}

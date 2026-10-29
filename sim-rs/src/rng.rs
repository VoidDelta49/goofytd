//! mulberry32, bit-identical to `src/sim/rng.js`.

pub struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self { a: seed }
    }

    /// Next value in [0, 1), exactly as the JS version computes it.
    pub fn next_f64(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_js() {
        // From node: const r = mulberry32(42); [r(), r(), r()]
        let mut r = Mulberry32::new(42);
        let got = [r.next_f64(), r.next_f64(), r.next_f64()];
        assert_eq!(got, [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
    }
}

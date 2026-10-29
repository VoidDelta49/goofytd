//! Flow field for cows. A line-for-line port of `src/sim/navgrid.js`
//! (`rebuild` and the flood behind `reachableWith`). Neighbour order, heap
//! order and float operations match the JS exactly, so `dist` and `next`
//! come out bit-identical. Change both files together.
//!
//! Marking cells (solid, goal, towers) stays in JS: it runs once per level
//! or per tower and writes straight into these arrays through typed-array
//! views over WASM memory.

use std::f64::consts::SQRT_2;

/// dx, dz, step cost. Orthogonals first (same order as the JS).
const NEIGHBOURS: [(i32, i32, f64); 8] = [
    (1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
    (1, 1, SQRT_2), (1, -1, SQRT_2), (-1, 1, SQRT_2), (-1, -1, SQRT_2),
];

pub struct NavGrid {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub solid: Vec<u8>,
    pub tower: Vec<i32>,
    pub goal: Vec<u8>,
    pub dist: Vec<f64>,
    pub next: Vec<i32>,
    pub extra: Vec<u8>,
    pub seen: Vec<u8>,
    queue: Vec<u32>,
    heap: MinHeap,
}

impl NavGrid {
    pub fn new(w: usize, h: usize, cell: f64) -> Self {
        let n = w * h;
        Self {
            w,
            h,
            cell,
            solid: vec![0; n],
            tower: vec![0; n],
            goal: vec![0; n],
            dist: vec![f64::INFINITY; n],
            next: vec![-1; n],
            extra: vec![0; n],
            seen: vec![0; n],
            queue: vec![0; n],
            heap: MinHeap::new(n),
        }
    }

    #[inline(always)]
    fn open(&self, i: usize) -> bool {
        self.solid[i] == 0 && self.tower[i] == 0 && self.extra[i] == 0
    }

    #[inline(always)]
    fn can_step(&self, cx: i32, cz: i32, dx: i32, dz: i32) -> bool {
        let (nx, nz) = (cx + dx, cz + dz);
        if nx < 0 || nz < 0 || nx >= self.w as i32 || nz >= self.h as i32 {
            return false;
        }
        let w = self.w as i32;
        if !self.open((nz * w + nx) as usize) {
            return false;
        }
        if dx != 0 && dz != 0 {
            return self.open((cz * w + nx) as usize) && self.open((nz * w + cx) as usize);
        }
        true
    }

    /// Dijkstra outward from every walkable goal cell.
    pub fn rebuild(&mut self) {
        self.dist.fill(f64::INFINITY);
        self.next.fill(-1);
        self.heap.clear();
        for i in 0..self.dist.len() {
            if self.goal[i] != 0 && self.solid[i] == 0 && self.tower[i] == 0 {
                self.dist[i] = 0.0;
                self.heap.push(i as u32, 0.0);
            }
        }
        let w = self.w as i32;
        while self.heap.size > 0 {
            let d = self.heap.top_key();
            let i = self.heap.pop() as usize;
            if d > self.dist[i] {
                continue; // stale entry
            }
            let cx = i as i32 % w;
            let cz = i as i32 / w;
            for &(dx, dz, cost) in NEIGHBOURS.iter() {
                if !self.can_step(cx, cz, dx, dz) {
                    continue;
                }
                let j = (i as i32 + dz * w + dx) as usize;
                let nd = d + cost * self.cell;
                if nd < self.dist[j] {
                    self.dist[j] = nd;
                    self.next[j] = i as i32;
                    self.heap.push(j as u32, nd);
                }
            }
        }
    }

    /// Breadth-first flood from open goal cells; `seen[i] == 1` if reachable.
    pub fn flood(&mut self) {
        self.seen.fill(0);
        let (mut head, mut tail) = (0usize, 0usize);
        for i in 0..self.seen.len() {
            if self.goal[i] != 0 && self.open(i) {
                self.seen[i] = 1;
                self.queue[tail] = i as u32;
                tail += 1;
            }
        }
        let w = self.w as i32;
        while head < tail {
            let i = self.queue[head] as i32;
            head += 1;
            let (cx, cz) = (i % w, i / w);
            for &(dx, dz, _) in NEIGHBOURS.iter() {
                if !self.can_step(cx, cz, dx, dz) {
                    continue;
                }
                let j = (i + dz * w + dx) as usize;
                if self.seen[j] == 0 {
                    self.seen[j] = 1;
                    self.queue[tail] = j as u32;
                    tail += 1;
                }
            }
        }
    }
}

/// Binary min-heap with lazy deletion; same sift order as the JS MinHeap.
struct MinHeap {
    items: Vec<u32>,
    keys: Vec<f64>,
    size: usize,
}

impl MinHeap {
    fn new(capacity: usize) -> Self {
        Self { items: vec![0; capacity * 8 + 8], keys: vec![0.0; capacity * 8 + 8], size: 0 }
    }
    fn clear(&mut self) {
        self.size = 0;
    }
    fn top_key(&self) -> f64 {
        self.keys[0]
    }
    fn push(&mut self, item: u32, key: f64) {
        let mut i = self.size;
        self.size += 1;
        while i > 0 {
            let p = (i - 1) >> 1;
            if self.keys[p] <= key {
                break;
            }
            self.items[i] = self.items[p];
            self.keys[i] = self.keys[p];
            i = p;
        }
        self.items[i] = item;
        self.keys[i] = key;
    }
    fn pop(&mut self) -> u32 {
        let top = self.items[0];
        self.size -= 1;
        let last = self.size;
        let (item, key) = (self.items[last], self.keys[last]);
        let mut i = 0;
        loop {
            let mut c = 2 * i + 1;
            if c >= last {
                break;
            }
            if c + 1 < last && self.keys[c + 1] < self.keys[c] {
                c += 1;
            }
            if self.keys[c] >= key {
                break;
            }
            self.items[i] = self.items[c];
            self.keys[i] = self.keys[c];
            i = c;
        }
        self.items[i] = item;
        self.keys[i] = key;
        top
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walls_and_diagonal_corners() {
        // 5x3 grid, goal at (0,1), wall at (2,0) and (2,1): cows must go round via (2,2).
        let mut g = NavGrid::new(5, 3, 1.0);
        g.goal[5] = 1;
        g.solid[2] = 1;
        g.solid[7] = 1;
        g.rebuild();
        assert_eq!(g.dist[5], 0.0);
        assert_eq!(g.dist[6], 1.0);
        // (3,1) can't cut the (2,1)/(2,2) corner diagonally... it goes (3,1)->(3,2)->(2,2)->(1,1)/(1,2).
        assert!(g.dist[8].is_finite());
        assert_eq!(g.next[2], -1);
        assert!(g.dist[2].is_infinite());
    }

    #[test]
    fn flood_respects_extra() {
        let mut g = NavGrid::new(3, 1, 1.0);
        g.goal[0] = 1;
        g.flood();
        assert_eq!(g.seen, vec![1, 1, 1]);
        g.extra[1] = 1;
        g.flood();
        assert_eq!(g.seen, vec![1, 0, 0]);
    }
}

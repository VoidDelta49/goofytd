//! CowTD simulation core in Rust, loaded by the browser and Node as plain
//! WebAssembly (no wasm-bindgen). The JS side lives in `src/sim/wasm/`.
//!
//! Ported so far: the nav grid's flow field (`navgrid`) and the seeded RNG
//! (`rng`, used once cows and towers move over). Everything must stay
//! bit-identical to the JS version: lockstep co-op replays ticks on every
//! peer, and during the migration some peers may still run the JS sim.

pub mod navgrid;
pub mod rng;

use navgrid::NavGrid;

// ---- C ABI for the JS glue -------------------------------------------------
// Handles are raw pointers to boxed grids. JS frees them through a
// FinalizationRegistry, so a forgotten grid is reclaimed with its JS owner.

#[no_mangle]
pub extern "C" fn nav_new(w: u32, h: u32, cell: f64) -> *mut NavGrid {
    Box::into_raw(Box::new(NavGrid::new(w as usize, h as usize, cell)))
}

/// # Safety
/// `p` must come from `nav_new` and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn nav_free(p: *mut NavGrid) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

/// Address of one of the grid's arrays, for JS typed-array views:
/// 0 solid (u8), 1 tower (i32), 2 goal (u8), 3 dist (f64), 4 next (i32),
/// 5 extra (u8), 6 seen (u8). The arrays never reallocate after `nav_new`.
///
/// # Safety
/// `p` must be a live grid.
#[no_mangle]
pub unsafe extern "C" fn nav_ptr(p: *mut NavGrid, which: u32) -> usize {
    let g = &mut *p;
    match which {
        0 => g.solid.as_mut_ptr() as usize,
        1 => g.tower.as_mut_ptr() as usize,
        2 => g.goal.as_mut_ptr() as usize,
        3 => g.dist.as_mut_ptr() as usize,
        4 => g.next.as_mut_ptr() as usize,
        5 => g.extra.as_mut_ptr() as usize,
        6 => g.seen.as_mut_ptr() as usize,
        _ => 0,
    }
}

/// # Safety
/// `p` must be a live grid.
#[no_mangle]
pub unsafe extern "C" fn nav_rebuild(p: *mut NavGrid) {
    (*p).rebuild();
}

/// Flood from the goal cells with `extra` cells closed; result in `seen`.
///
/// # Safety
/// `p` must be a live grid.
#[no_mangle]
pub unsafe extern "C" fn nav_flood(p: *mut NavGrid) {
    (*p).flood();
}

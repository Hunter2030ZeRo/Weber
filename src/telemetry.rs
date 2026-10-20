use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    time::Instant,
};

pub struct Telemetry {
    start: Instant,
    path: Option<PathBuf>,
    frames: Cell<u64>,
    presented: Cell<u64>,
    ready_after: Cell<Option<u64>>,
    first_present: Cell<bool>,
    input: Cell<Option<Instant>>,
    acknowledged: Cell<Option<u64>>,
    intervals: RefCell<Vec<f64>>,
    last_present: Cell<Option<Instant>>,
    application_failure: RefCell<Option<String>>,
    profile_frames: bool,
    timings: RefCell<std::collections::BTreeMap<&'static str, Vec<(f64, f64)>>>,
}

impl Telemetry {
    pub fn new(start: Instant) -> Self {
        Self {
            start,
            path: std::env::var_os("WEBER_TELEMETRY").map(PathBuf::from),
            frames: Cell::new(0),
            presented: Cell::new(0),
            ready_after: Cell::new(None),
            first_present: Cell::new(false),
            input: Cell::new(None),
            acknowledged: Cell::new(None),
            intervals: RefCell::new(Vec::new()),
            last_present: Cell::new(None),
            application_failure: RefCell::new(None),
            profile_frames: std::env::var("WEBER_FRAME_PROFILE").as_deref() == Ok("1"),
            timings: RefCell::default(),
        }
    }
    pub fn emit(&self, data: serde_json::Value) {
        let Some(path) = &self.path else {
            return;
        };
        write_event(path, self.start, data);
    }
    pub fn report(&self, data: serde_json::Value) {
        match data["stage"].as_str() {
            Some("ready") => {
                self.ready_after.set(Some(self.frames.get()));
                self.intervals.borrow_mut().clear();
                self.last_present.set(None);
            }
            Some("input-update") => self.acknowledged.set(Some(self.frames.get())),
            Some("failure") if crate::assets::application().is_some() => {
                self.application_failure.replace(Some(
                    data["message"]
                        .as_str()
                        .unwrap_or("Application failed")
                        .to_owned(),
                ));
            }
            _ => {}
        }
        self.emit(data);
    }
    pub fn application_failure(&self) -> Option<String> {
        self.application_failure.borrow().clone()
    }
    pub fn input(&self, kind: &str) {
        if self.path.is_none() {
            return;
        }
        if self.acknowledged.get().is_none() {
            self.input.set(Some(Instant::now()));
        }
        self.emit(json!({ "stage": "native-input", "kind": kind }));
    }
    pub fn frame(&self) {
        self.frames.set(self.frames.get() + 1);
    }
    pub fn present(&self) {
        if self.path.is_none() || self.presented.get() == self.frames.get() {
            return;
        }
        self.presented.set(self.frames.get());
        let now = Instant::now();
        if let Some(previous) = self.last_present.replace(Some(now)) {
            let mut intervals = self.intervals.borrow_mut();
            if intervals.len() < 10000 {
                intervals.push(now.duration_since(previous).as_secs_f64() * 1000.0);
            }
        }
        if !self.first_present.get()
            && self
                .ready_after
                .get()
                .is_some_and(|frame| self.frames.get() > frame)
        {
            self.first_present.set(true);
            self.emit(json!({ "stage": "first-app-present", "startupMs": self.start.elapsed().as_secs_f64() * 1000.0 }));
        }
        if self
            .acknowledged
            .get()
            .is_some_and(|frame| self.frames.get() > frame)
        {
            if let Some(start) = self.input.take() {
                self.emit(json!({ "stage": "input-present", "latencyMs": now.duration_since(start).as_secs_f64() * 1000.0 }));
            }
            self.acknowledged.set(None);
        }
    }
    pub fn finish(&self) {
        if self.profile_frames {
            self.emit(json!({ "stage": "frame-profile", "samples": *self.timings.borrow(), "units": ["wallMs", "threadCpuMs"], "note": "Diagnostic instrumentation, includes startup; missing CPU clock is null." }));
        }
        self.emit(json!({ "stage": "presentation-summary", "intervalsMs": *self.intervals.borrow(), "firstAppPresented": self.first_present.get() }));
    }
    pub fn measure<T>(&self, stage: &'static str, work: impl FnOnce() -> T) -> T {
        if !self.profile_frames {
            return work();
        }
        let wall = Instant::now();
        let cpu = thread_cpu_ms();
        let result = work();
        let elapsed = wall.elapsed().as_secs_f64() * 1000.0;
        let used = thread_cpu_ms() - cpu;
        let mut timings = self.timings.borrow_mut();
        let samples = timings.entry(stage).or_default();
        if samples.len() < 10000 {
            samples.push((elapsed, used));
        }
        result
    }
}

#[cfg(target_os = "linux")]
#[expect(
    unsafe_code,
    reason = "Read the current thread CPU clock into an initialized timespec"
)]
fn thread_cpu_ms() -> f64 {
    let mut value = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut value) } != 0 {
        return f64::NAN;
    }
    value.tv_sec as f64 * 1000.0 + value.tv_nsec as f64 / 1_000_000.0
}
#[cfg(not(target_os = "linux"))]
fn thread_cpu_ms() -> f64 {
    f64::NAN
}

pub fn write_event(path: &std::path::Path, start: Instant, data: serde_json::Value) {
    static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let Ok(_guard) = WRITER.lock() else {
        return;
    };
    let event = json!({ "unixTimeMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0, "hostElapsedMs": start.elapsed().as_secs_f64() * 1000.0, "data": data });
    if let Err(error) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| writeln!(file, "{event}"))
    {
        log::error!("Telemetry write: {error}");
    }
}

use weber_runtime_config::{load_runtime_plan, parse_invocation, Invocation};

fn run() -> weber_runtime_config::Result<i32> {
    let invocation = parse_invocation(std::env::args_os().skip(1))?;
    let (project, runtime_root, forwarded, check) = match invocation {
        Invocation::Help => {
            println!("weber-backend run [--project DIRECTORY] [--runtime-root DIRECTORY] [-- APPLICATION_ARGUMENTS...]\nweber-backend check [--project DIRECTORY] [--runtime-root DIRECTORY] [-- APPLICATION_ARGUMENTS...]");
            return Ok(0);
        }
        Invocation::Run { project, runtime_root, forwarded } => (project, runtime_root, forwarded, false),
        Invocation::Check { project, runtime_root, forwarded } => (project, runtime_root, forwarded, true),
    };
    let plan = load_runtime_plan(&project, &forwarded, runtime_root.as_deref())?;
    if check {
        println!("backend = {}\nproject = {:?}\nexecutable = {:?}\narguments = {:?}",
            plan.backend.name(), plan.project, plan.executable, plan.arguments);
        return Ok(0);
    }
    let mut command = plan.command();
    #[cfg(unix)]
    {
        // Replace the launcher: signals, stdio and exit status belong to the
        // backend itself, with no intermediary process or signal translation.
        use std::os::unix::process::CommandExt;
        Err(plan.launch_error(command.exec()))
    }
    #[cfg(not(unix))]
    {
        command.status()
            .map(|status| status.code().unwrap_or(1))
            .map_err(|error| plan.launch_error(error))
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Weber: {error}");
            std::process::exit(1);
        }
    }
}

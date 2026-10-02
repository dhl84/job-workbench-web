# Job Workbench, the page

The front end of a personal job application tracker. It is nine static files and
no build step.

The page holds no private data. It reads and writes the tracker through Supabase,
and it shows nothing until somebody signs in. `config.js` carries the project
address and the `anon` key. That key is public by design: it grants nothing on its
own, because every table refuses a request that carries no session.

The notes, the CVs and the application folders are not here. They stay in a private
repository.

Source of truth: the `web/` directory of the private `cv_private` repository. This
repository is a copy for hosting, so change it there.

use std::{fs, env};
use std::path::PathBuf;
use std::time::{Duration, Instant, UNIX_EPOCH};
use home;
use actix_files;
use actix_web::{
    get, web, App, error,
    HttpServer, Responder, Result,
    middleware::Logger,
    HttpResponse,
    http::{header::ContentType, StatusCode},
};
use dotenv::dotenv;
use serde::Serialize;
use serde::Deserialize;
use log::{info, warn};
use sha2::{Sha256, Digest};
use derive_more::{Display, Error};

#[derive(Debug, Display, Error)]
enum HttpError {
    #[display(fmt = "Internal Server Error")]
    InternalServerError,
    #[display(fmt = "Not Found")]
    NotFound,
    #[display(fmt = "Bad Request")]
    BadRequest,
}

impl error::ResponseError for HttpError {
    fn status_code(&self) -> StatusCode {
        match *self {
            HttpError::InternalServerError => StatusCode::INTERNAL_SERVER_ERROR,
            HttpError::NotFound => StatusCode::NOT_FOUND,
            HttpError::BadRequest => StatusCode::BAD_REQUEST,
        }
    }

    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status_code())
            .insert_header(ContentType::json())
            .json(ErrorResponse {
                error: self.to_string(),
            })
    }
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Serialize)]
struct FolderEntry {
    name: String,
    path: String,
    symlink: bool,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    mtime: f64,
    symlink: bool,
}

#[derive(Serialize)]
struct FolderHash {
    hash: String,
    duration: Duration,
}

#[derive(Serialize)]
struct FolderList {
    canonical_path: String,
    folders: Vec<FolderEntry>,
    files: Vec<FileEntry>,
    hash: FolderHash,
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

const EXTENSIONS: [&'static str; 9] = [
    ".jpg",
    ".jpeg",
    ".png",
    ".svg",
    ".gif",
    ".webp",
    ".webm",
    ".mp4",
    ".mkv",
];


fn listdrives() -> Vec<String> {
    let mut drives = vec![];

    if env::consts::OS == "windows" {
        for drive in "ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars() {
            let drivestr = format!("{}:\\", drive);
            let path = PathBuf::from(drivestr.clone());
            if path.exists() {
                drives.push(drivestr)
            }
        }
    }

    drives
}

fn default_path() -> PathBuf {
    let home_path = home::home_dir().unwrap();
    let pictures = home_path.join("Pictures");
    if pictures.exists() {
        pictures
    } else {
        home_path
    }
}

fn calculate_folder_hash(path: PathBuf) -> Result<(String, Duration)> {
    let start = Instant::now();
    let mut names: Vec<String> = vec![];

    let readdir = fs::read_dir(path)?;
    for entry in readdir {
        let Ok(direntry) = entry else {
            continue;
        };

        let filename = direntry.file_name().to_owned();
        let Some(strname) = filename.to_str() else {
            continue;
        };
        names.push(strname.into());
    }

    names.sort();

    let mut hasher = Sha256::new();
    for name in &names {
        hasher.update(name.as_bytes());
    }

    let result = hasher.finalize().to_vec();
    let r2: Vec<_> = result.iter().map(|v| format!("{:02x}", v)).collect();

    Ok((r2.join(""), start.elapsed()))
}

fn escape(s: String) -> String {
    let mut new_s = s.clone();
    new_s = new_s.replace("&", "&amp;");
    new_s = new_s.replace("<", "&lt;");
    new_s = new_s.replace(">", "&gt;");
    new_s = new_s.replace("\"", "&quot;");
    new_s
}

fn create_fav_html(name: String, path: PathBuf) -> String {
    format!(
        "<div><a href=\"{0}\" title=\"{1}\" data-folder=\"{0}\">{1}</a></div>",
        escape(normalize_path(path).0), escape(name)
    )
}

fn normalize_path(path: PathBuf) -> (String, PathBuf) {
    let canon_path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => path.clone(),
    };

    let mut normalized_path: String = path.to_string_lossy().into();
    normalized_path = normalized_path.replace("\\", "/");

    // i don't care anymore
    if (env::consts::OS == "windows") && normalized_path.starts_with("//?/") {
        normalized_path = normalized_path[4..].to_string();
    }

    (normalized_path, canon_path)
}

fn check_tilde(path: PathBuf) -> PathBuf {
    let tmp_path: PathBuf = normalize_path(path).0.into();
    if tmp_path.starts_with("~/") {
        let Some(homedir) = home::home_dir() else {
            return tmp_path.into();
        };

        let Ok(stripped_path) = tmp_path.strip_prefix("~/") else {
            return tmp_path;
        };

        homedir.join(stripped_path)
    } else {
        tmp_path
    }
}

#[get("/")]
async fn get_index() -> Result<impl Responder, HttpError> {
    let drives = listdrives();

    let Ok(mut html) = fs::read_to_string("./static/index.html") else {
        warn!("Could not read index.html");
        return Err(HttpError::InternalServerError);
    };

    // replace {{favs}} marker with drives and favourites
    let mut favs_html = String::new();
    for drive in drives {
        let tmp = create_fav_html(drive.clone(), PathBuf::from(&drive));
        favs_html.push_str(&tmp);
    }

    let fav_folders_env = env::var("FAV_FOLDERS").unwrap_or("".into());
    info!("found configured fav folders:");

    let parts = fav_folders_env.split(";");
    for fav_folder in parts {
        info!(" - {}", fav_folder);

        let fav_path = check_tilde(PathBuf::from(fav_folder));

        let Some(fav_name) = fav_path.file_name() else {
            continue;
        };

        if !fav_path.exists() {
            warn!("   `- Path doesn't exist!");
            continue;
        }

        let tmp = create_fav_html(
            fav_name.to_string_lossy().into(),
            fav_path,
        );
        favs_html.push_str(&tmp);
    }

    html = html.replace("{{favs}}", &favs_html);

    Ok(
        HttpResponse::Ok()
            .content_type(ContentType::html())
            .body(html)
    )
}

#[get("/list")]
async fn get_folder_list(path: web::Query<PathQuery>) -> Result<impl Responder, HttpError> {
    let input_path = if path.path.is_empty() {
        default_path()
    } else {
        PathBuf::from(&path.path)
    };

    let (normalized_path, canonical_path) = normalize_path(input_path.clone());

    // canonical_path is only used to test if the folder exists
    let Ok(current_meta) = canonical_path.metadata() else {
        return Err(HttpError::NotFound);
    };
    if !canonical_path.exists() || !current_meta.is_dir() {
        return Err(HttpError::NotFound);
    }

    let parent = match input_path.parent() {
        Some(path) => path.to_path_buf(),
        None => input_path.clone(),
    };

    let mut folders: Vec<FolderEntry> = vec![FolderEntry {
        name: "..".into(),
        path: normalize_path(parent).0,
        symlink: false,
    }];

    let mut files: Vec<FileEntry> = vec![];

    {
        let Ok(paths) = fs::read_dir(input_path.clone()) else {
            return Err(HttpError::NotFound);
        };
        for path in paths {
            let Ok(direntry) = path else {
                warn!("Could not unwrap path");
                continue;
            };
            let Ok(canon_path) = direntry.path().canonicalize() else {
                warn!("Could not canonicalize path.");
                continue;
            };
            let Ok(meta) = direntry.metadata() else {
                warn!("Could not get direntry metadata.");
                continue;
            };
            let Ok(meta_canon) = canon_path.metadata() else {
                warn!("Could not get direntry metadata of resolved path.");
                continue;
            };

            let entry_name: String = direntry.file_name().to_string_lossy().into();
            if meta_canon.is_dir() {
                folders.push(FolderEntry {
                    path: normalize_path(direntry.path()).0,
                    name: entry_name,
                    symlink: meta.is_symlink(),
                })
            } else {
                let mtime = match meta.modified() {
                    Ok(time) => match time.duration_since(UNIX_EPOCH) {
                        Ok(duration) => duration.as_secs_f64(),
                        Err(_) => 0.0
                    },
                    Err(_) => 0.0
                };

                let lowercase: String = entry_name.to_ascii_lowercase();
                if EXTENSIONS.iter().all(|v| !lowercase.ends_with(v)) {
                    continue;
                }

                files.push(FileEntry {
                    path: normalize_path(direntry.path()).0,
                    name: entry_name,
                    mtime,
                    symlink: meta.is_symlink(),
                });
            }
        }
    }

    let Ok((hash, duration)) = calculate_folder_hash(input_path.clone()) else {
        warn!("Could not calculate folder hash.");
        return Err(HttpError::InternalServerError);
    };

    let folder_list = FolderList {
        canonical_path: normalized_path,
        folders,
        files,
        hash: FolderHash { hash, duration },
    };
    Ok(web::Json(folder_list))
}

#[get("/get-file")]
async fn get_file(path: web::Query<PathQuery>) -> Result<actix_files::NamedFile, HttpError> {
    let (_, canonical_path) = normalize_path(PathBuf::from(&path.path));
    if !canonical_path.exists() {
        return Err(HttpError::NotFound);
    }
    let Ok(meta) = canonical_path.metadata() else {
        return Err(HttpError::NotFound);
    };
    if !meta.is_file() {
        return Err(HttpError::BadRequest);
    }
    let Ok(file) = actix_files::NamedFile::open(canonical_path) else {
        return Err(HttpError::InternalServerError);
    };
    Ok(file)
}

#[get("/folder-hash")]
async fn get_folder_hash(path: web::Query<PathQuery>) -> Result<impl Responder, HttpError> {
    let (_, canonical_path) = normalize_path(PathBuf::from(&path.path));
    if !canonical_path.exists() {
        return Err(HttpError::NotFound);
    }
    let Ok(meta) = canonical_path.metadata() else {
        return Err(HttpError::NotFound);
    };
    if !meta.is_dir() {
        return Err(HttpError::BadRequest);
    }
    let Ok((hash, duration)) = calculate_folder_hash(canonical_path) else {
        warn!("Could not calculate folder hash.");
        return Err(HttpError::InternalServerError);
    };

    Ok(web::Json(FolderHash { hash, duration }))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenv().ok();
    env_logger::init();

    HttpServer::new(move || {
        App::new()
            .wrap(Logger::default())
            .service(actix_files::Files::new("/static", "./static"))
            .service(get_index)
            .service(get_folder_list)
            .service(get_file)
            .service(get_folder_hash)
    })
        .bind(("127.0.0.1", 5000))?
        .run()
        .await
}

use std::{fs, env};
use std::path::PathBuf;
use std::time::{UNIX_EPOCH};
use home;
use actix_files;
use actix_web::{get, web, App, HttpServer, Responder, Result, middleware::Logger, HttpResponse};
use actix_web::http::header::ContentType;
use serde::Serialize;
use serde::Deserialize;
use log::warn;
use sha2::{Sha256, Digest};

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
struct FolderList {
    canonical_path: String,
    folders: Vec<FolderEntry>,
    files: Vec<FileEntry>,
    hash: String,
}

#[derive(Serialize)]
struct FolderHash {
    hash: String,
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

const EXTENSIONS: [&'static str; 8] = [
    ".jpg",
    ".jpeg",
    ".png",
    ".svg",
    ".gif",
    ".webp",
    ".webm",
    ".mp4",
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

fn resolve_path(path: &String) -> PathBuf {
    if path.is_empty() {
        default_path()
    } else {
        PathBuf::from(path).canonicalize().unwrap_or_else(|_| default_path())
    }
}

fn calculate_folder_hash(path: PathBuf) -> Result<String> {
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

    Ok(r2.join(""))
}

fn escape(s: String) -> String {
    let mut new_s = s.clone();
    new_s = new_s.replace("&", "&amp;");
    new_s = new_s.replace("<", "&lt;");
    new_s = new_s.replace(">", "&gt;");
    new_s = new_s.replace("\"", "&quot;");
    new_s
}

fn create_fav_html(name: String, path: String) -> String {
    format!(
        "<div><a href=\"{0}\" title=\"{1}\" data-folder=\"{0}\">{1}</a></div>",
        escape(path), escape(name)
    )
}

#[get("/")]
async fn get_index() -> Result<impl Responder> {
    let drives = listdrives();

    let mut html = fs::read_to_string("./static/index.html")?;

    // replace {{favs}} marker with drives and favourites
    let mut favs_html = String::new();
    for drive in drives {
        let tmp = create_fav_html(drive.clone(), drive.clone());
        favs_html.push_str(&tmp);
    }

    let tmp = create_fav_html(
        "Random".into(),
        "C:\\Users\\chaoz\\Pictures\\Random".into(),
    );
    favs_html.push_str(&tmp);

    html = html.replace("{{favs}}", &favs_html);

    Ok(
        HttpResponse::Ok()
            .content_type(ContentType::html())
            .body(html)
    )
}

#[get("/list")]
async fn get_folder_list(path: web::Query<PathQuery>) -> Result<impl Responder> {
    let canonical_path = resolve_path(&path.path);

    let parent = match canonical_path.parent() {
        Some(path) => path.to_path_buf(),
        None => canonical_path.clone(),
    };

    let mut folders: Vec<FolderEntry> = vec![FolderEntry {
        name: "..".into(),
        path: parent.to_string_lossy().into(),
        symlink: false,
    }];

    let mut files: Vec<FileEntry> = vec![];

    {
        let paths = fs::read_dir(canonical_path.clone())?;
        for path in paths {
            let Ok(direntry) = path else {
                warn!("Could not unwrap path");
                continue;
            };
            let Ok(meta) = direntry.metadata() else {
                warn!("Could not get direntry metadata.");
                continue;
            };

            if meta.is_dir() {
                folders.push(FolderEntry {
                    path: direntry.path().to_string_lossy().into(),
                    name: direntry.file_name().to_string_lossy().into(),
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

                let lowercase: String = direntry.file_name().to_ascii_lowercase().to_string_lossy().into();
                if EXTENSIONS.iter().all(|v| !lowercase.ends_with(v)) {
                    continue;
                }

                files.push(FileEntry {
                    path: direntry.path().to_string_lossy().into(),
                    name: direntry.file_name().to_string_lossy().into(),
                    mtime,
                    symlink: meta.is_symlink(),
                });
            }
        }
    }

    let folder_list = FolderList {
        canonical_path: canonical_path.to_string_lossy().into(),
        folders,
        files,
        hash: "uiaeuiaeuiae".to_owned(),
    };
    Ok(web::Json(folder_list))
}

#[get("/get-file")]
async fn get_file(path: web::Query<PathQuery>) -> Result<actix_files::NamedFile> {
    let canonical_path = resolve_path(&path.path);
    Ok(actix_files::NamedFile::open(canonical_path.to_str().unwrap())?)
}

#[get("/folder-hash")]
async fn get_folder_hash(path: web::Query<PathQuery>) -> Result<impl Responder> {
    let canonical_path = resolve_path(&path.path);
    let hash = calculate_folder_hash(canonical_path)?;
    Ok(web::Json(FolderHash { hash }))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
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
        .bind(("127.0.0.1", 8080))?
        .run()
        .await
}

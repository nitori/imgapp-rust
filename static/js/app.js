/*
This file is part of imgapp.

imgapp is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

imgapp is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
imgapp. If not, see <https://www.gnu.org/licenses/>.
*/
import $ from './jquery.js';
import {html, toggleFullscreen} from './utils.js';

/**
 * @typedef {{name: string, path: string}} ResponseFolder
 * @typedef {{name: string, path: string, mtime: Number}} ResponseFile
 * @typedef {{
 *  canonical_path: string,
 *  folders: ResponseFolder[],
 *  files: ResponseFile[],
 *  hash: string
 * }} ResponseList
 */

/**
 * @typedef {{name: string, path: string, symlink: Boolean}} AppFolder
 * @typedef {{name: string, path: string, symlink: Boolean, mtime: Number}} AppFile
 *
 * @typedef {{
 *  folderHash: string|null,
 *  currentPath: string|null,
 *  currentFile: string|null,
 *  folders: AppFolder[],
 *  files: AppFile[],
 *  showHidden: boolean,
 *  sortOrder: string,
 *  sortBy: string
 * }} AppState
 */

const MAX_CACHED_IMAGES = 50;
const HIDE_CURSOR_TIMEOUT = 5000;
const SYMLINK_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" style="height: 1em; width: auto; vertical-align: top; margin-right:.25em;" width="512" height="512" viewBox="0 0 512 512">
    <!--!Font Awesome Pro 6.5.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2024 Fonticons, Inc.-->
    <path fill="currentColor" d="M320 0H288V64h32 82.7L201.4 265.4 178.7 288 224 333.3l22.6-22.6L448 109.3V192v32h64V192 32 0H480 320zM32 32H0V64 480v32H32 456h32V480 352 320H424v32 96H64V96h96 32V32H160 32z"/>
</svg>`;

/** @type {AppState} */
const defaultState = {
    folderHash: null,
    currentPath: null,
    currentFile: null,

    folders: [],
    files: [],
    showHidden: false,

    sortBy: 'name',
    sortOrder: 'asc',

    volume: 1.0,
}

export default class App {
    constructor() {
        this.$left = $('#left');
        this.$path = $('#path');
        this.$folders = $('#folders');
        this.$files = $('#files');

        this.$right = $('#right');
        this.$imageHolder = $('#image');
        this.$sortingShortcuts = $('#sorting-shortcuts');
        this.$meta = $('#meta');

        this._listRebuildRequired = true;
        this._previousFolder = null;

        // path string -> Image object
        /** @type {Object.<string, {img: HTMLImageElement, ts: number}>} */
        this._fileCache = {};

        this.load();
        this._fetchList(this.state.currentPath, true);
        this._startPolling();
    }

    load() {
        let state = localStorage.getItem('imageapp-state');
        if (typeof state === 'string') {
            try {
                state = JSON.parse(state);
            } catch (e) {
                console.error(e);
                state = null;
            }
        }

        if (state === null) {
            state = {};
        }

        /** @type {AppState} */
        this.state = {...defaultState, ...state};

        // get index for quicker access.
        this._fileIndex = Math.max(0, this.state.files.findIndex(f => f.path === this.state.currentFile));
    }

    save() {
        localStorage.setItem('imageapp-state', JSON.stringify(this.state));
        history.pushState('', {}, '#' + this.state.currentPath);
    }

    async _startPolling() {
        const schedule = () => window.setTimeout(() => this._startPolling(), 10000);
        if (this.state.currentPath === null) {
            schedule();
            return;
        }

        let data;
        try {
            let resp = await fetch('/folder-hash?' + $.param({path: this.state.currentPath}));
            data = await resp.json();
        } catch (e) {
            console.error(e);
            schedule();
            return;
        }

        try {
            if (this.state.folderHash !== data.hash) {
                await this._fetchList(this.state.currentPath, true);
            }
        } finally {
            schedule();
        }
    }

    /**
     * @param path {string|null}
     * @param [forceRebuild] {boolean}
     * @returns {Promise<void>}
     * @private
     */
    async _fetchList(path, forceRebuild) {
        /** @type ResponseList */
        let data;
        try {
            let resp = await fetch('/list?' + $.param({path}));
            data = await resp.json();
        } catch (e) {
            console.error(e);
        }

        this._listRebuildRequired = this.state.currentPath !== data.canonical_path || forceRebuild === true;

        this.state.currentPath = data.canonical_path;
        this.state.folders = data.folders;
        this.state.files = data.files;
        this.state.folderHash = data.hash.hash;
        this._resort();

        if (this.state.files.length > 0) {
            this._fileIndex = this.state.files.findIndex(f => f.path === this.state.currentFile);
            if (this._fileIndex === -1) {
                this._fileIndex = 0;
                this.state.currentFile = this.state.files[this._fileIndex].path;
            }
        } else {
            this.state.currentFile = null;
        }

        this.save();
        this._render();
    }

    nextFile() {
        if (this.state.files.length === 0) {
            return;
        }
        this._fileIndex = Math.min(this.state.files.length - 1, this._fileIndex + 1);
        this.state.currentFile = this.state.files[this._fileIndex].path;
        this.save();
        this._render();
        this.setObjectPosition(0, 0);
    }

    prevFile() {
        if (this.state.files.length === 0) {
            return;
        }
        this._fileIndex = Math.max(0, this._fileIndex - 1);
        this.state.currentFile = this.state.files[this._fileIndex].path;
        this.save();
        this._render();
    }

    changeSort(sortBy, sortOrder) {
        if (this.state.sortBy === sortBy && this.state.sortOrder === sortOrder) {
            return;
        }
        this.state.sortBy = sortBy;
        this.state.sortOrder = sortOrder;
        this._resort();
    }

    _resort() {
        const sortBy = this.state.sortBy;
        const sortOrder = this.state.sortOrder;

        this.state.folders.sort((a, b) => {
            let aVal = a.name;
            let bVal = b.name;
            aVal = aVal.toLowerCase().replace(/[\[\]\(\)\{}<>]+/g, '');
            bVal = bVal.toLowerCase().replace(/[\[\]\(\)\{}<>]+/g, '');
            if (aVal === '..') return -1;
            if (bVal === '..') return 1;
            if (aVal === bVal) return 0;
            if (aVal < bVal) return -1;
            return 1;
        });

        this.state.files.sort((a, b) => {
            let aVal = a[sortBy];
            let bVal = b[sortBy];
            if (sortBy === 'name') {
                aVal = aVal.toLowerCase().replace(/[\[\]\(\)\{}<>]+/g, '');
                bVal = bVal.toLowerCase().replace(/[\[\]\(\)\{}<>]+/g, '');
            }
            if (aVal === bVal) {
                return 0;
            }
            if (aVal < bVal) {
                return sortOrder === 'asc' ? -1 : 1;
            }
            return sortOrder === 'asc' ? 1 : -1;
        });

        this._fileIndex = Math.max(0, this.state.files.findIndex(f => f.path === this.state.currentFile));
        this.save();
        this._render();
    }

    _render() {
        this.$path.text(this.state.currentPath);

        if (this._listRebuildRequired) {
            this.$folders.empty();
            this.state.folders.forEach(f => {
                if (!this.state.showHidden && f.name.startsWith('.') && f.name !== '..') {
                    return;
                }
                this.$folders.append(html`
                    <div><a href="#${f.path}" class="${
                            this._previousFolder === f.path ? 'previous' : ''
                    }" data-folder="${f.path}">$${f.symlink ? SYMLINK_ICON : ''}${f.name}</a></div>`);
            });

            this.$files.empty();
            this.state.files.forEach(f => {
                if (!this.state.showHidden && f.name.startsWith('.')) {
                    return;
                }
                this.$files.append(html`
                    <div><a href="#${f.path}" class="${
                            this.state.currentFile === f.path ? 'active' : ''
                    }" data-file="${f.path}">$${f.symlink ? SYMLINK_ICON : ''}${f.name}</a></div>`);
            });
        } else {
            this.$files.find('a').removeClass('active');
            this.$files.find(`a[data-file="${CSS.escape(this.state.currentFile)}"]`).addClass('active');

            this.$folders.find('a').removeClass('previous');
            this.$folders.find(`a[data-folder="${CSS.escape(this._previousFolder)}"]`).addClass('previous');
        }

        this._setupEvents();
        this._listRebuildRequired = false;
        this._renderImage();
        this._renderSortingShortcuts();
        this._focusCurrentFile();
        this._focusPreviousFolder();
    }

    _renderImage() {
        if (this.state.currentFile === null) {
            this.$imageHolder.empty();
            document.title = 'Image Viewer';
            this.$meta.empty();
            return;
        }
        document.title = this.state.currentFile.split(/\//).pop();

        this.$imageHolder.empty();
        let $media;

        if (this.state.currentFile.match(/\.(mp4|webm|mkv)$/)) {
            $media = $(this._getVideo(this.state.currentFile));
        } else {
            $media = $(this._getImage(this.state.currentFile));
            this._cleanupCache();
        }

        this.$imageHolder.append($media);
        this._preloadNextAndPrevious();

        const updateMeta = () => {
            let {width, height} = this._getResolution();
            if (width > 0 && height > 0) {
                this.$meta.html(`
                    <span class="resolution">${width}x${height}</span>
                    <span>&nbsp;-&nbsp;</span>
                    <span>${this._fileIndex + 1}/${this.state.files.length}</span>
                `);
            } else {
                window.requestAnimationFrame(updateMeta);
            }
        }
        window.requestAnimationFrame(updateMeta);
    }

    _getVideo(file) {
        let url = new URL(`/get-file`, window.location.origin);
        url.searchParams.append('path', file);

        let video = document.createElement('video');
        video.controls = true;
        video.autoplay = true;
        video.loop = true;
        video.src = url.toString();
        video.classList.add('media-item');
        video.addEventListener('volumechange', ev => {
            this.state.volume = ev.target.volume;
            this.save();
        });
        video.volume = this.state.volume || 1.0;
        return video;
    }

    _getImage(file) {
        let url = new URL(`/get-file`, window.location.origin);
        url.searchParams.append('path', file);

        if (!this._fileCache.hasOwnProperty(file)) {
            this._fileCache[file] = {
                img: new Image(),
                ts: Date.now() / 1000.0,
            };
            this._fileCache[file].img.src = url.toString();
            this._fileCache[file].img.classList.add('media-item');
        } else {
            this._fileCache[file].ts = Date.now() / 1000.0;
        }

        if (url.searchParams.get('path').endsWith('.gif')) {
            url.searchParams.set('t', String(Date.now()));
            this._fileCache[file].img.src = url.toString();
        }

        return this._fileCache[file].img;
    }

    _getResolution() {
        const $media = this.$imageHolder.find('.media-item');
        let width = $media[0] && $media[0].naturalWidth || $media[0].videoWidth || 0;
        let height = $media[0] && $media[0].naturalHeight || $media[0].videoHeight || 0;
        return {width, height};
    }

    _cleanupCache() {
        // keep only 10 images in cache.
        let keys = Object.keys(this._fileCache);
        if (keys.length > MAX_CACHED_IMAGES) {
            let oldestKey = keys.reduce((a, b) => {
                if (this._fileCache[a].ts < this._fileCache[b].ts) {
                    return a;
                }
                return b;
            });
            delete this._fileCache[oldestKey];
        }
    }

    _preloadNextAndPrevious() {
        if (this.state.files.length === 0) {
            return;
        }
        let nextIndex = Math.min(this.state.files.length - 1, this._fileIndex + 1);
        let prevIndex = Math.max(0, this._fileIndex - 1);
        if (!this.state.files[nextIndex].path.match(/\.(mp4|webm|mkv)$/)) {
            this._getImage(this.state.files[nextIndex].path);
        }
        if (!this.state.files[prevIndex].path.match(/\.(mp4|webm|mkv)$/)) {
            this._getImage(this.state.files[prevIndex].path);
        }
    }

    _renderSortingShortcuts() {
        this.$sortingShortcuts.empty();
        this.$sortingShortcuts.append(`<span class="${this.state.sortBy === 'name' ? 'active' : ''}">n: name</span><br>`);
        this.$sortingShortcuts.append(`<span class="${this.state.sortBy === 'mtime' ? 'active' : ''}">m: mtime</span><br>`);
        this.$sortingShortcuts.append(`<span class="${this.state.sortOrder === 'desc' ? 'active' : ''}">r: reverse</span><br>`);
        this.$sortingShortcuts.append(`<span class="${this.state.showHidden ? 'active' : ''}">h: hidden</span><br>`);
    }

    _focusCurrentFile() {
        if (this.state.currentFile === null) {
            return;
        }
        let $el = this.$files.find(`*[data-file="${CSS.escape(this.state.currentFile)}"]`);
        if ($el.length === 0) {
            return;
        }

        let $parent = $el.closest('#files');
        if (this._posWithin($el[0], $parent[0])) {
            return
        }
        $el[0].scrollIntoView({behavior: 'instant', block: 'center'});
    }

    _focusPreviousFolder() {
        if (this._previousFolder === null) {
            return;
        }
        let $el = this.$folders.find(`*[data-folder="${CSS.escape(this._previousFolder)}"]`);
        if ($el.length === 0) {
            return;
        }

        let $parent = $el.closest('#folders');
        if (this._posWithin($el[0], $parent[0])) {
            return
        }
        $el[0].scrollIntoView({behavior: 'instant', block: 'center'});
    }

    _posWithin(el, parentEl) {
        let rect = el.getBoundingClientRect();
        let parentRect = parentEl.getBoundingClientRect();
        return rect.top >= parentRect.top && rect.bottom <= parentRect.bottom;
    }

    _setupEvents() {
        this.$left.find('a[data-folder]').off('click').on('click', ev => {
            ev.preventDefault();
            this._previousFolder = this.state.currentPath;
            let newPath = $(ev.target).attr('data-folder');
            this._fetchList(newPath);
        });

        this.$left.find('a[data-file]').off('click').on('click', ev => {
            ev.preventDefault();
            let filePath = $(ev.target).attr('data-file');
            this.state.currentFile = filePath;
            this._fileIndex = this.state.files.findIndex(f => f.path === filePath);
            this.save();
            this._render();
        });

        $(window).off('keydown').on('keydown', ev => {
            if (ev.key === 'PageDown') {
                ev.preventDefault();
                this.nextFile();
            } else if (ev.key === 'PageUp') {
                ev.preventDefault();
                this.prevFile();
            } else if (ev.key === 'Home') {
                ev.preventDefault();
                if (this._isObjectFitCover() || this._isObjectFitNone()) {
                    this.setObjectPosition(0, 0);
                } else {
                    this._fileIndex = 0;
                    this.state.currentFile = this.state.files[this._fileIndex].path;
                    this.save();
                    this._render();
                }
            } else if (ev.key === 'End') {
                ev.preventDefault();
                if (this._isObjectFitCover() || this._isObjectFitNone()) {
                    this.setObjectPosition(100, 100);
                } else {
                    this._fileIndex = this.state.files.length - 1;
                    this.state.currentFile = this.state.files[this._fileIndex].path;
                    this.save();
                    this._render();
                }
            } else if (ev.key === 'f') {
                ev.preventDefault();
                toggleFullscreen(this.$imageHolder[0]);
            } else if (ev.key === 'h') {
                ev.preventDefault();
                this.state.showHidden = !this.state.showHidden;
                this.save();
                this._listRebuildRequired = true;
                this._render();
            } else if (ev.key === 'r') {
                ev.preventDefault();
                this.changeSort(this.state.sortBy, this.state.sortOrder === 'asc' ? 'desc' : 'asc');
                this._listRebuildRequired = true;
                this._render();
            } else if (ev.key === 'n') {
                ev.preventDefault();
                this.changeSort('name', this.state.sortOrder);
                this._listRebuildRequired = true;
                this._render();
            } else if (ev.key === 'm') {
                ev.preventDefault();
                this.changeSort('mtime', this.state.sortOrder);
                this._listRebuildRequired = true;
                this._render();
            } else if (ev.key === 'z') {
                ev.preventDefault();
                if (this.$imageHolder.hasClass('object-fit-cover')) {
                    this.$imageHolder.removeClass('object-fit-cover');
                    this.$imageHolder.addClass('object-fit-none');
                } else if (this.$imageHolder.hasClass('object-fit-none')) {
                    this.$imageHolder.removeClass('object-fit-cover');
                    this.$imageHolder.removeClass('object-fit-none');
                    this.$imageHolder.find('.media-item').css('object-position', '');
                } else {
                    this.$imageHolder.addClass('object-fit-cover');
                }
            }
        });

        this.$imageHolder.off('wheel').on('wheel', ev => {
            if (ev.originalEvent.deltaY < 0) {
                if (this._isObjectFitCover() || this._isObjectFitNone()) {
                    this.moveMediaUp();
                } else {
                    this.prevFile();
                }
            } else if (ev.originalEvent.deltaY > 0) {
                if (this._isObjectFitCover() || this._isObjectFitNone()) {
                    this.moveMediaDown();
                } else {
                    this.nextFile();
                }
            }
        });

        let hideCursorTimer = null;
        this.$imageHolder.off('mousemove').on('mousemove', ev => {
            if (hideCursorTimer !== null) {
                clearTimeout(hideCursorTimer);
            }

            this.$imageHolder.removeClass('hide-cursor');
            hideCursorTimer = setTimeout(() => {
                this.$imageHolder.addClass('hide-cursor');
            }, HIDE_CURSOR_TIMEOUT);
        });
    }


    getCurrentObjectPosition() {
        const $mediaItem = this.$imageHolder.find('.media-item');
        const pos = ($mediaItem.css('object-position') || '50% 50%').trim();
        const parts = pos.split(/\s+/);
        if (parts.length !== 2) {
            return [50, 50];
        }
        let x = parseFloat(parts[0]);
        let y = parseFloat(parts[1]);

        if (
            !isNaN(x) && !isNaN(y)
            && parts[0].endsWith('%') && parts[1].endsWith('%')
        ) {
            return [x, y];
        }
        return [50, 50];
    }

    setObjectPosition(x, y) {
        x = Math.max(0, Math.min(100, x));
        y = Math.max(0, Math.min(100, y));
        if (this._direction() == 'up') {
            x = 50;
        } else {
            y = 50;
        }
        const $mediaItem = this.$imageHolder.find('.media-item');
        if (this._isMediaBigger()) {
            $mediaItem.css('object-position', `${x}% ${y}%`);
        }
    }

    _resolution() {
        const $mediaItem = this.$imageHolder.find('.media-item');
        const width = $mediaItem[0] && $mediaItem[0].naturalWidth || $mediaItem[0].videoWidth;
        const height = $mediaItem[0] && $mediaItem[0].naturalHeight || $mediaItem[0].videoHeight;
        return {width, height};
    }

    _direction() {
        let {width, height} = this._resolution();
        let cWidth = this.$imageHolder.width();
        let cHeight = this.$imageHolder.height();
        if (width/height < cWidth/cHeight) {
            return 'up';
        }
        return 'down';
    }

    _isMediaBigger() {
        if (this._isObjectFitCover() || this._isObjectFitNone()) {
            let {width, height} = this._resolution();
            let cWidth = this.$imageHolder.width();
            let cHeight = this.$imageHolder.height();
            return width > cWidth || height > cHeight;
        }
        return false;
    }

    _calcStep() {
        let {width, height} = this._resolution();
        let r = height > width ? width / height : height / width;
        return Math.max(1, Math.min(50, r * 10));
    }

    moveMediaUp() {
        let [x, y] = this.getCurrentObjectPosition();
        let step = this._calcStep();
        this.setObjectPosition(x - step, y - step);
    }

    moveMediaDown() {
        let [x, y] = this.getCurrentObjectPosition();
        let step = this._calcStep();
        this.setObjectPosition(x + step, y + step);
    }

    _isObjectFitCover() {
        return this.$imageHolder.hasClass('object-fit-cover');
    }

    _isObjectFitNone() {
        return this.$imageHolder.hasClass('object-fit-none');
    }
}

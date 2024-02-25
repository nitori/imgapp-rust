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
export function escape(text) {
    return text.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#039;')
        .replace(/"/g, '&quot;');
}

export function html(strings, ...values) {
    let result = strings[0];
    for (let i = 0; i < values.length; i++) {
        if (result.endsWith('$')) {
            result = result.slice(0, -1);
            result += values[i].toString() + strings[i + 1];
        } else {
            result += escape(values[i].toString()) + strings[i + 1];
        }
    }
    return result;
}

export function toggleFullscreen(elem) {
    if (!document.fullscreenElement) {
        if (elem.requestFullscreen) {
            elem.requestFullscreen();
            document.documentElement.classList.add('fullscreen');
        }
    } else {
        document.documentElement.classList.remove('fullscreen');
        document.exitFullscreen();
    }
}

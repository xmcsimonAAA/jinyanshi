(function () {
    'use strict';

    function _dM(target, source) {
        if (!source || typeof source !== 'object') return target;
        const out = Array.isArray(target) ? target.slice() : Object.assign({}, target);
        Object.keys(source).forEach(function (key) {
            const sv = source[key];
            const tv = out[key];
            if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
                out[key] = _dM(tv, sv);
            } else {
                out[key] = sv;
            }
        });
        return out;
    }
    function _clone(o) { return JSON.parse(JSON.stringify(o == null ? {} : o)); }
    function _getRawBaseCfg() {
        if (window.I18N && typeof window.I18N.___rawBaseCfg === 'function') return window.I18N.___rawBaseCfg();
        var base = window.GOLDENROCK_CONFIG || {};
        try {
            var overrideStr = localStorage.getItem('GOLDENROCK_CONFIG_OVERRIDE');
            if (overrideStr) return _dM(_clone(base), JSON.parse(overrideStr));
        } catch (e) {}
        return base;
    }

    const GOLDENROCK_CONFIG = (function loadConfig() {
        if (window.I18N && typeof window.I18N.getConfig === 'function') {
            return window.I18N.getConfig();
        }
        return _getRawBaseCfg();
    })();

    window.GOLDENROCK_CONFIG_RESOLVED = GOLDENROCK_CONFIG;

    function resolvePath(obj, path) {
        return path.split('.').reduce(function (acc, k) {
            return acc == null ? acc : acc[k];
        }, obj);
    }

    function processDynFieldBindings(node, item) {
        const applyBindings = function (el) {
            const f = el.getAttribute('data-dyn-f');
            if (f === null) return;
            const t = el.getAttribute('data-dyn-t') || 'text';
            const v = (f && f.length > 0) ? item[f] : item;
            if (v !== undefined && v !== null) {
                if (t === 'html') el.innerHTML = String(v).replace(/\n/g, '<br>');
                else if (t === 'href') el.setAttribute('href', v);
                else if (t === 'value') el.setAttribute('value', v);
                else el.textContent = v;
            }
            const fv = el.getAttribute('data-dyn-fv');
            if (fv && item[fv] !== undefined && item[fv] !== null) {
                el.setAttribute('value', item[fv]);
            }
            const fhref = el.getAttribute('data-dyn-fhref');
            if (fhref && item[fhref] !== undefined && item[fhref] !== null) {
                el.setAttribute('href', item[fhref]);
            }
        };
        applyBindings(node);
        node.querySelectorAll('[data-dyn-f]').forEach(function (el) { applyBindings(el); });
    }

    function resetAllListContainers(root) {
        root = root || document;
        const containers = root.querySelectorAll('[data-dyn-list]');
        containers.forEach(function (container) {
            // 如果存了模板快照：重置容器 innerHTML = tmpl（带 data-dyn-tmpl 属性）+ 清所有 processed 标记
            const snap = container.getAttribute('data-dyn-tmpl-snap');
            const tmpl = container.querySelector('[data-dyn-tmpl]');
            if (snap) {
                try {
                    const wrap = document.createElement('div');
                    wrap.innerHTML = snap;
                    const tmplNode = wrap.firstElementChild;
                    if (tmplNode) {
                        tmplNode.setAttribute('data-dyn-tmpl', '');
                        container.innerHTML = '';
                        container.appendChild(tmplNode);
                        container.removeAttribute('data-dyn-list-processed');
                    }
                } catch (e) { /* ignore */ }
            } else if (tmpl) {
                // 还没存过快照（第一次渲染前）：保留模板、清 processed
                Array.prototype.slice.call(container.children).forEach(function (ch) {
                    if (ch !== tmpl) container.removeChild(ch);
                });
                container.removeAttribute('data-dyn-list-processed');
            } else {
                container.removeAttribute('data-dyn-list-processed');
            }
        });
    }

    function processListContainers(root, cfg, scope) {
        const containers = root.querySelectorAll('[data-dyn-list]');
        containers.forEach(function (container) {
            if (container.hasAttribute('data-dyn-list-processed')) return;
            const key = container.getAttribute('data-dyn-list');
            const tmpl = container.querySelector('[data-dyn-tmpl]');
            let items = (scope !== undefined && scope !== null) ? resolvePath(scope, key) : undefined;
            if (!Array.isArray(items)) items = resolvePath(cfg, key);
            if (!Array.isArray(items) || !tmpl) {
                container.setAttribute('data-dyn-list-processed', '1');
                return;
            }
            tmpl.removeAttribute('data-dyn-tmpl');
            const tmplHtml = tmpl.outerHTML;
            // 首次存模板快照，后续 resetAllListContainers 用
            if (!container.hasAttribute('data-dyn-tmpl-snap')) {
                container.setAttribute('data-dyn-tmpl-snap', tmplHtml);
            }
            tmpl.remove();
            container.setAttribute('data-dyn-list-processed', '1');
            items.forEach(function (item, idx) {
                const wrap = document.createElement('div');
                wrap.innerHTML = tmplHtml;
                const node = wrap.firstElementChild;
                if (!node) return;

                processDynFieldBindings(node, item);

                node.querySelectorAll('[data-dyn-cond]').forEach(function (el) {
                    const c = el.getAttribute('data-dyn-cond');
                    if (!resolvePath({item: item}, c)) el.remove();
                });
                node.querySelectorAll('[data-dyn-idx]').forEach(function (el) {
                    el.textContent = String(idx + 1).padStart(2, '0');
                });
                container.appendChild(node);

                processListContainers(node, cfg, item);
            });
        });
    }

    function isImageDataUrl(s) {
        return typeof s === 'string' && s.indexOf('data:image/') === 0;
    }
    function renderFavicon(faviconSlot, raw) {
        if (!faviconSlot) return;
        if (typeof raw !== 'string') return;
        raw = raw.trim();
        if (!raw) return;
        if (isImageDataUrl(raw)) {
            faviconSlot.setAttribute('href', raw);
            return;
        }
        if (raw.substr(0, 1) === '/' || raw.substr(0, 4) === 'http' || /\.(png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i.test(raw)) {
            faviconSlot.setAttribute('href', raw);
            return;
        }
        faviconSlot.setAttribute('href', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(raw));
    }
    function renderSvgInner(el, raw, cfg) {
        if (!el) return;
        if (isImageDataUrl(raw)) {
            const img = document.createElement('img');
            img.src = raw;
            img.alt = 'logo';
            img.style.cssText = 'display:block;max-width:100%;max-height:100%;height:100%;width:auto;object-fit:contain;';
            el.innerHTML = '';
            el.appendChild(img);
            return;
        }
        let html = String(raw || '').trim();
        if (!html) return;
        if (html.indexOf('{{LOGO_CN}}') > -1 && cfg && cfg.brand && typeof cfg.brand.logoCn === 'string') {
            html = html.replace(/\{\{LOGO_CN\}\}/g, cfg.brand.logoCn);
        }
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const newSvg = tmp.querySelector('svg');
        if (newSvg) {
            el.innerHTML = '';
            el.appendChild(newSvg);
            return;
        }
        const newImg = tmp.querySelector('img');
        if (newImg) {
            el.innerHTML = '';
            newImg.setAttribute('alt', newImg.getAttribute('alt') || 'logo');
            newImg.style.cssText = (newImg.getAttribute('style') || '' + ';max-width:100%;max-height:100%;height:100%;width:auto;object-fit:contain;display:block;');
            el.appendChild(newImg);
        }
    }

    function renderDynamicContent() {
        const cfgBase = (typeof _getRawBaseCfg === 'function') ? _getRawBaseCfg() : GOLDENROCK_CONFIG;
        let cfg = cfgBase;
        if (window.I18N && typeof window.I18N.getCfgOverrides === 'function') {
            cfg = _dM(cfgBase, window.I18N.getCfgOverrides());
        }
        const rawCfg = cfgBase;

        document.title = cfg.site && cfg.site.title ? cfg.site.title : document.title;
        const metaDesc = document.querySelector('meta[name="description"]');
        const metaKw = document.querySelector('meta[name="keywords"]');
        if (cfg.site && cfg.site.metaDescription && metaDesc) metaDesc.setAttribute('content', cfg.site.metaDescription);
        if (cfg.site && cfg.site.metaKeywords && metaKw) metaKw.setAttribute('content', cfg.site.metaKeywords);

        const favSlot = document.querySelector('link[data-favicon-slot]');
        if (favSlot && cfg.site) {
            if (typeof cfg.site.faviconSvg === 'string' && cfg.site.faviconSvg.trim()) {
                renderFavicon(favSlot, cfg.site.faviconSvg);
            } else if (cfg.site.faviconEmoji) {
                const svgStr = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0A1628"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="36">' +
                    cfg.site.faviconEmoji + '</text></svg>';
                favSlot.setAttribute('href', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr));
            }
        }

        document.querySelectorAll('[data-dyn]').forEach(function (el) {
            const key = el.getAttribute('data-dyn');
            const type = el.getAttribute('data-type') || 'text';

            var useCfg = cfg;
            if (key === 'brand.logoHeaderSvg'
                || key === 'brand.logoFooterSvgTpl'
                || key === 'brand.logoIconOnlySvg'
                || key === 'brand.loginLogoSvg'
                || key === 'site.faviconSvg') {
                useCfg = rawCfg;
            }

            const val = resolvePath(useCfg, key);
            if (val === undefined || val === null) return;

            if (type === 'html') {
                el.innerHTML = String(val).replace(/\n/g, '<br>');
            } else if (type === 'attr') {
                const attr = el.getAttribute('data-attr') || 'content';
                el.setAttribute(attr, val);
            } else if (type === 'href') {
                el.setAttribute('href', val);
            } else if (type === 'svg-inner') {
                if (typeof val === 'string' && val.trim()) {
                    renderSvgInner(el, val, useCfg);
                }
            } else {
                el.textContent = val;
            }
        });

        resetAllListContainers(document);
        processListContainers(document, cfg);

        document.querySelectorAll('.service-card').forEach(function (card) {
            card.classList.remove('service-card-featured');
            if (card.querySelector('.featured-badge')) {
                card.classList.add('service-card-featured');
            }
        });

        if (window.I18N && typeof window.I18N.applyI18nAttrs === 'function') {
            window.I18N.applyI18nAttrs(document);
        }
        if (window.I18N && typeof window.I18N.setSwitcherActive === 'function') {
            window.I18N.setSwitcherActive();
        }
    }

    function createVcIconSvg(type) {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 32 32');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('xmlns', NS);
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.75');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');

        function el(name, attrs) {
            var e = document.createElementNS(NS, name);
            if (attrs) {
                Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
            }
            return e;
        }

        if (type === 'hq') {
            svg.appendChild(el('line', { x1: '3', y1: '28', x2: '29', y2: '28' }));
            svg.appendChild(el('rect', { x: '6', y: '14', width: '8', height: '14', rx: '0.5' }));
            svg.appendChild(el('rect', { x: '16', y: '6', width: '9', height: '22', rx: '0.5' }));
            svg.appendChild(el('line', { x1: '7.5', y1: '17', x2: '12.5', y2: '17' }));
            svg.appendChild(el('line', { x1: '7.5', y1: '19.5', x2: '12.5', y2: '19.5' }));
            svg.appendChild(el('line', { x1: '7.5', y1: '22', x2: '12.5', y2: '22' }));
            svg.appendChild(el('line', { x1: '7.5', y1: '24.5', x2: '12.5', y2: '24.5' }));
            svg.appendChild(el('line', { x1: '7.5', y1: '27', x2: '12.5', y2: '27' }));
            svg.appendChild(el('line', { x1: '18', y1: '9', x2: '23', y2: '9' }));
            svg.appendChild(el('line', { x1: '18', y1: '11.5', x2: '23', y2: '11.5' }));
            svg.appendChild(el('line', { x1: '18', y1: '14', x2: '23', y2: '14' }));
            svg.appendChild(el('line', { x1: '18', y1: '16.5', x2: '23', y2: '16.5' }));
            svg.appendChild(el('line', { x1: '18', y1: '19', x2: '23', y2: '19' }));
            svg.appendChild(el('line', { x1: '18', y1: '21.5', x2: '23', y2: '21.5' }));
            svg.appendChild(el('line', { x1: '18', y1: '24', x2: '23', y2: '24' }));
            svg.appendChild(el('line', { x1: '18', y1: '26.5', x2: '23', y2: '26.5' }));
            svg.appendChild(el('line', { x1: '20.5', y1: '6', x2: '20.5', y2: '2.5', 'stroke-width': '2' }));
            var ant = el('path', { d: 'M18.5 2.5 L22.5 2.5 L20.5 0.5 Z', fill: 'currentColor', 'stroke-width': '1.2' });
            svg.appendChild(ant);
        } else if (type === 'mkts') {
            svg.appendChild(el('line', { x1: '3', y1: '27', x2: '29', y2: '27', 'stroke-dasharray': '2 1.2' }));
            svg.appendChild(el('line', { x1: '6', y1: '27', x2: '6', y2: '27', 'stroke-width': '0' }));
            svg.appendChild(el('line', { x1: '6.5', y1: '7', x2: '6.5', y2: '14', 'stroke-width': '2', stroke: '#E74C3C' }));
            svg.appendChild(el('rect', { x: '4.5', y: '12', width: '4', height: '6', fill: '#E74C3C', opacity: '0.25', stroke: '#E74C3C' }));
            svg.appendChild(el('line', { x1: '6.5', y1: '18', x2: '6.5', y2: '23', stroke: '#E74C3C' }));
            svg.appendChild(el('line', { x1: '11', y1: '9', x2: '11', y2: '15', 'stroke-width': '2', stroke: '#E74C3C' }));
            svg.appendChild(el('rect', { x: '9', y: '13', width: '4', height: '5', fill: '#E74C3C', opacity: '0.25', stroke: '#E74C3C' }));
            svg.appendChild(el('line', { x1: '11', y1: '18', x2: '11', y2: '24', stroke: '#E74C3C' }));
            svg.appendChild(el('line', { x1: '15.5', y1: '10', x2: '15.5', y2: '17', 'stroke-width': '2', stroke: '#E74C3C' }));
            svg.appendChild(el('rect', { x: '13.5', y: '15', width: '4', height: '4', fill: '#E74C3C', opacity: '0.25', stroke: '#E74C3C' }));
            svg.appendChild(el('line', { x1: '15.5', y1: '19', x2: '15.5', y2: '25', stroke: '#E74C3C' }));
            svg.appendChild(el('line', { x1: '20.5', y1: '14', x2: '20.5', y2: '22', 'stroke-width': '2', stroke: '#27AE60' }));
            svg.appendChild(el('rect', { x: '18.5', y: '13', width: '4', height: '9', fill: '#27AE60', opacity: '0.2', stroke: '#27AE60' }));
            svg.appendChild(el('line', { x1: '20.5', y1: '22', x2: '20.5', y2: '26.5', stroke: '#27AE60' }));
            svg.appendChild(el('line', { x1: '25', y1: '12', x2: '25', y2: '20', 'stroke-width': '2', stroke: '#27AE60' }));
            svg.appendChild(el('rect', { x: '23', y: '10', width: '4', height: '10', fill: '#27AE60', opacity: '0.2', stroke: '#27AE60' }));
            svg.appendChild(el('line', { x1: '25', y1: '20', x2: '25', y2: '26.5', stroke: '#27AE60' }));
            svg.appendChild(el('line', { x1: '29.5', y1: '10', x2: '29.5', y2: '17', 'stroke-width': '2', stroke: '#27AE60' }));
            svg.appendChild(el('rect', { x: '27.5', y: '7.5', width: '4', height: '9.5', fill: '#27AE60', opacity: '0.2', stroke: '#27AE60' }));
            svg.appendChild(el('line', { x1: '29.5', y1: '17', x2: '29.5', y2: '26.5', stroke: '#27AE60' }));
        } else if (type === 'clients') {
            svg.appendChild(el('rect', { x: '4', y: '8', width: '18', height: '16', rx: '2' }));
            svg.appendChild(el('rect', { x: '10', y: '4', width: '18', height: '16', rx: '2', fill: 'currentColor', opacity: '0.04' }));
            svg.appendChild(el('circle', { cx: '14', cy: '10', r: '2' }));
            svg.appendChild(el('line', { x1: '17.5', y1: '9', x2: '24.5', y2: '9' }));
            svg.appendChild(el('line', { x1: '17.5', y1: '11.5', x2: '22', y2: '11.5' }));
            svg.appendChild(el('circle', { cx: '20', cy: '5', r: '2' }));
            svg.appendChild(el('line', { x1: '23.5', y1: '4', x2: '26', y2: '4' }));
            svg.appendChild(el('line', { x1: '23.5', y1: '6.5', x2: '25.5', y2: '6.5' }));
            svg.appendChild(el('path', { d: 'M22.5 24.5 C23.8 23.2 25.5 23.2 26.8 24.5', 'stroke-width': '1.6' }));
            svg.appendChild(el('path', { d: 'M23.5 25.5 C24.4 24.6 25.6 24.6 26.5 25.5', 'stroke-width': '1.4' }));
        }
        return svg;
    }

    function injectCustomIcons() {
        var cfTmpl = document.getElementById('cfIconTemplates');
        if (cfTmpl) {
            var cfCards = document.querySelectorAll('.cf-card');
            var cfTypes = ['safe-1', 'safe-2', 'safe-3', 'safe-4'];
            cfCards.forEach(function (card, idx) {
                if (idx >= cfTypes.length) return;
                var wrap = card.querySelector('.cf-icon');
                if (!wrap) return;
                var src = cfTmpl.content.getElementById('cf-icon-' + cfTypes[idx]);
                if (src) {
                    wrap.innerHTML = '';
                    wrap.appendChild(src.cloneNode(true));
                }
            });
        }

        var vcIcons = document.querySelectorAll('.vc-icon[data-vc-icon]');
        vcIcons.forEach(function (el) {
            var key = (el.textContent || '').trim();
            if (!key) return;
            var svg = createVcIconSvg(key);
            if (svg) {
                el.innerHTML = '';
                el.appendChild(svg);
            }
        });

        var svcTmpl = document.getElementById('svcIconTemplates');
        if (svcTmpl) {
            var svcIds = ['trade', 'research', 'global'];
            var svcCards = document.querySelectorAll('.service-card');
            svcCards.forEach(function (card, idx) {
                if (idx >= svcIds.length) return;
                var wrap = card.querySelector('.service-icon');
                if (!wrap) return;
                var src = svcTmpl.content.getElementById('svc-icon-' + svcIds[idx]);
                if (src) {
                    wrap.innerHTML = '';
                    wrap.appendChild(src.cloneNode(true));
                }
            });
        }

        var valueTmpl = document.getElementById('valueIconTemplates');
        if (valueTmpl) {
            var valueWraps = document.querySelectorAll('.value-icon-wrap');
            var valueIds = ['0', '1', '2', '3'];
            valueWraps.forEach(function (wrap, idx) {
                if (idx >= valueIds.length) return;
                var src = valueTmpl.content.getElementById('value-icon-' + valueIds[idx]);
                if (src) {
                    wrap.innerHTML = '';
                    wrap.appendChild(src.cloneNode(true));
                }
            });
        }

        var contactTmpl = document.getElementById('contactIconTemplates');
        if (contactTmpl) {
            var contactItems = document.querySelectorAll('.contact-item');
            var contactIds = ['location', 'phone', 'email', 'time'];
            contactItems.forEach(function (item, idx) {
                if (idx >= contactIds.length) return;
                var wrap = item.querySelector('.ci-icon');
                if (!wrap) return;
                var src = contactTmpl.content.getElementById('ci-icon-' + contactIds[idx]);
                if (src) {
                    wrap.innerHTML = '';
                    wrap.appendChild(src.cloneNode(true));
                }
            });
        }
    }

    function bootstrap() {
        renderDynamicContent();
        injectCustomIcons();
        handleNavbarScroll();
        handleActiveNav();
        initScrollReveal();
        initHeroInteractions();
    }

    // 语言切换时原地 SPA 重渲染（不刷新页面），供 window.GR_RENDER_ALL 调用
    function renderAllOnLangChange() {
        renderDynamicContent();
        injectCustomIcons();
        // 滚动/激活 nav 重新计算
        handleNavbarScroll();
        handleActiveNav();
        // data-i18n 属性级补全（applyI18nAttrs 已在 I18N.switchLang 调用过，这里兜底）
        try { if (window.I18N && typeof window.I18N.applyI18nAttrs === 'function') window.I18N.applyI18nAttrs(document); } catch (e) {}
    }
    if (typeof window.GR_RENDER_ALL !== 'function') {
        window.GR_RENDER_ALL = renderAllOnLangChange;
    } else {
        var prev = window.GR_RENDER_ALL;
        window.GR_RENDER_ALL = function () { try { prev(); } catch (e) {} try { renderAllOnLangChange(); } catch (e) {} };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }

    const navbar = document.getElementById('navbar');
    const mobileToggle = document.getElementById('mobileToggle');
    const navMenu = document.getElementById('navMenu');
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('section[id]');
    const contactForm = document.getElementById('contactForm');

    function handleNavbarScroll() {
        const scrollY = window.scrollY;
        if (scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    }

    function handleActiveNav() {
        const scrollY = window.scrollY + 120;

        sections.forEach(function (section) {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.offsetHeight;
            const sectionId = section.getAttribute('id');
            const correspondingLink = document.querySelector('.nav-link[href="#' + sectionId + '"]');

            if (!correspondingLink) return;

            if (scrollY >= sectionTop && scrollY < sectionTop + sectionHeight) {
                navLinks.forEach(function (link) {
                    link.classList.remove('active');
                });
                correspondingLink.classList.add('active');
            }
        });
    }

    function toggleMobileMenu() {
        mobileToggle.classList.toggle('active');
        navMenu.classList.toggle('active');
        document.body.style.overflow = navMenu.classList.contains('active') ? 'hidden' : '';
    }

    function closeMobileMenu() {
        mobileToggle.classList.remove('active');
        navMenu.classList.remove('active');
        document.body.style.overflow = '';
    }

    function smoothScrollTo(e) {
        const target = e.currentTarget.getAttribute('href');
        if (!target || target.charAt(0) !== '#') return;

        e.preventDefault();
        const targetElement = document.querySelector(target);
        if (!targetElement) return;

        const isMobileNav = e.currentTarget.closest('.nav-menu');
        if (isMobileNav && navMenu.classList.contains('active')) {
            closeMobileMenu();
        }

        const offsetTop = Math.max(0, Math.round(targetElement.getBoundingClientRect().top + window.scrollY - 80));
        // 用户主动点了 tab：通知 I18N 滚动模块立即取消旧 savedY 还原调度 + 清掉旧还原定时器，避免被拉回旧位置；同时把新锚点 y 写入 sessionStorage（如果用户点完立刻 F5，就还原这个新位置）
        try { if (typeof window._GR_userClickedNav === 'function') window._GR_userClickedNav(target, offsetTop); } catch (err) {}

        // —— 关键 Bug 修复：之前的 window.scrollTo({top,behavior:'smooth'}) 会跟 I18N 的滚动恢复抢 scroll-behavior；
        //    这里用「瞬时切到 offsetTop（保证立即到位） + setTimeout 0 再 smooth 补动画」，同时清任何残留 doRestoreY 调度
        //    双重保险：先瞬时切 scroll-behavior auto 到位 → 恢复 smooth → 再用 smooth 对齐一次
        try { document.documentElement.style.setProperty('scroll-behavior','auto','important'); } catch (err) {}
        try { window.scrollTo(0, offsetTop); } catch (err) {}
        try { document.documentElement.scrollTop = offsetTop; } catch (err) {}
        try { document.body.scrollTop = offsetTop; } catch (err) {}
        // —— 跟剩余还原调度竞争：doRestoreY 在 i18n.js 里有 60/220/480/800/1800 等多轮，
        //    我们 20/60/160ms 都瞬时拉一次 offsetTop，保证最后落在用户要的锚点
        (function(yTarget, el){
          var pull = function(){
            if (typeof window._GR_userClickedNav === 'function') {
              // 先保证 _userNavigatingNow 锁上，后续任何 doRestoreY 都 return
              try { window._GR_userClickedNav(target, yTarget); } catch (err) {}
            }
            try { document.documentElement.style.setProperty('scroll-behavior','auto','important'); } catch (err) {}
            try { window.scrollTo(0, yTarget); } catch (err) {}
            try { document.documentElement.scrollTop = yTarget; } catch (err) {}
            try { document.body.scrollTop = yTarget; } catch (err) {}
          };
          setTimeout(function(){ pull(); setTimeout(function(){ pull(); setTimeout(pull, 100); }, 40); }, 20);
          setTimeout(function () {
            try { document.documentElement.style.removeProperty('scroll-behavior'); } catch (err) {}
            // 重新计算（因为瞬时切 auto 时可能已经到位，再做一次 smooth 让视觉过渡）
            try {
              if (!el) return;
              var rectNow = el.getBoundingClientRect();
              var nowY = Math.max(0, Math.round(rectNow.top + window.scrollY - 80));
              if (Math.abs(nowY - window.scrollY) > 3) {
                  window.scrollTo({ top: nowY, behavior: 'smooth' });
              }
            } catch (err) {}
          }, 260);
        })(offsetTop, targetElement);

        // 同步更新 URL hash（不重新滚动）避免浏览器前进/后退跟保存记忆冲突
        try {
            var rawH = String(window.location.hash || '').replace(/^[#]/, '');
            var cleanTarget = target.replace(/^[#]/, '');
            if (rawH !== cleanTarget) {
                if ('replaceState' in history) history.replaceState(null, '', target);
                else window.location.hash = target;
            }
        } catch (err) {}

        // 点完 60ms 再更新一次 active nav，避免还没滚过去时旧 active 高亮闪烁
        setTimeout(function () {
            try {
                navLinks.forEach(function (link) { link.classList.remove('active'); });
                const hit = document.querySelector('.nav-link[href="' + target + '"]');
                if (hit) hit.classList.add('active');
            } catch (err) {}
        }, 60);
    }

    function initScrollReveal() {
        const revealElements = document.querySelectorAll(
            '.section-header, .about-content, .about-visual, .value-card, ' +
            '.service-card, .compliance-hero-card, .cf-card, .cta-card, ' +
            '.contact-item, .contact-form-wrap'
        );

        revealElements.forEach(function (el) {
            el.classList.add('reveal');
        });

        revealElements.forEach(function (el) {
            const rect = el.getBoundingClientRect();
            if (rect.top < window.innerHeight * 0.95) {
                el.classList.add('visible');
            }
        });

        if (!('IntersectionObserver' in window)) {
            revealElements.forEach(function (el) {
                el.classList.add('visible');
            });
            return;
        }

        const observer = new IntersectionObserver(
            function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                        observer.unobserve(entry.target);
                    }
                });
            },
            {
                threshold: 0.1,
                rootMargin: '0px 0px -50px 0px'
            }
        );

        revealElements.forEach(function (el) {
            observer.observe(el);
        });

        setTimeout(function () {
            document.querySelectorAll('.reveal:not(.visible)').forEach(function (el) {
                el.classList.add('visible');
            });
        }, 1500);
    }

    function initHeroInteractions() {
        const statValues = document.querySelectorAll('.hero-stats-inline .stat-value');
        statValues.forEach(function (el) {
            const original = el.textContent.trim();
            const match = original.match(/^(\d+(?:\.\d+)?)(\+?)$/);
            if (match) {
                const target = parseFloat(match[1]);
                const suffix = match[2] || '';
                const duration = 1400;
                const startTime = performance.now();

                function animate(now) {
                    const elapsed = now - startTime;
                    const progress = Math.min(elapsed / duration, 1);
                    const ease = 1 - Math.pow(1 - progress, 3);
                    const current = target * ease;
                    const display = Number.isInteger(target)
                        ? Math.floor(current)
                        : current.toFixed(1);
                    el.textContent = display + suffix;
                    if (progress < 1) {
                        requestAnimationFrame(animate);
                    } else {
                        el.textContent = original;
                        el.classList.add('counting');
                    }
                }
                requestAnimationFrame(animate);
            } else {
                el.classList.add('counting');
            }
        });

        const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        if (isTouch) return;

        const heroSection = document.getElementById('home');
        if (!heroSection) return;

        heroSection.addEventListener('mousemove', function (e) {
            const rect = heroSection.getBoundingClientRect();
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const dx = (e.clientX - rect.left - centerX) / centerX;
            const dy = (e.clientY - rect.top - centerY) / centerY;

            heroSection.querySelectorAll('.hero-parallax-layer[data-parallax]').forEach(function (layer) {
                const factor = parseFloat(layer.getAttribute('data-parallax')) || 0;
                const tx = dx * factor * 30;
                const ty = dy * factor * 20;
                layer.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';
            });
        });
    }

    function _t(k, fb) {
        if (window.I18N && typeof window.I18N.t === 'function') return window.I18N.t(k, fb);
        return fb != null ? fb : ('[' + k + ']');
    }

    function handleFormSubmit(e) {
        e.preventDefault();

        const form = e.currentTarget;
        const formData = new FormData(form);
        const name = formData.get('name');
        const email = formData.get('email');
        const message = formData.get('message');
        const privacy = formData.get('privacy');

        if (!name || !email || !message || !privacy) {
            alert(_t('ui.form.requiredAll', '请填写所有必填项并同意隐私政策。'));
            return;
        }

        const submitBtn = form.querySelector('button[type="submit"]');
        const originalText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML =
            '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" style="animation: spin 1s linear infinite;">' +
            '<path d="M9 2C12.866 2 16 5.13401 16 9C16 11.087 15.0903 12.9814 13.6262 14.3155" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
            '</svg> ' + _t('ui.form.submitLoading', '提交中...');

        var phoneEl = form.querySelector('[name="phone"]');
        var svcEl = form.querySelector('[name="service"]');
        var payload = {
            name: name || '',
            email: email || '',
            phone: phoneEl ? (phoneEl.value || '') : '',
            service: svcEl ? (svcEl.value || '') : '',
            message: message || '',
            lang: (window.I18N && window.I18N.activeLang) || 'zh_CN'
        };
        fetch('/api/messages', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (res) {
            if (!res.ok) throw new Error('message submit failed');
            return res.json();
        }).then(function () {
            submitBtn.innerHTML =
                '<svg width="18" height="18" viewBox="0 0 18 18" fill="none">' +
                '<path d="M3 9L7.5 13.5L15 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg> ' + _t('ui.form.submitSuccessBtn', '提交成功');
            submitBtn.style.background = 'linear-gradient(135deg, #4CAF50, #45a049)';
            setTimeout(function () {
                form.reset();
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
                submitBtn.style.background = '';
            }, 2500);
        }).catch(function () {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
            submitBtn.style.background = '';
            alert(_t('ui.form.submitFailed', '提交失败，请稍后再试或直接联系我们。'));
        });
    }

    const styleEl = document.createElement('style');
    styleEl.textContent =
        '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    document.head.appendChild(styleEl);

    window.addEventListener('scroll', function () {
        handleNavbarScroll();
        handleActiveNav();
    }, { passive: true });

    // —— 直接挂到 document 委托上，不用 querySelectorAll 取常量（避免 nav 渲染前取值为空、或新加入元素没绑 listener 的 CASE_D y=5524→点 about 没反应 Bug）
    //    所有 a[href^="#"]（包括 .nav-link / .logo / hero-actions CTA / footer）都走统一 smoothScrollTo
    document.addEventListener('click', function (e) {
        try {
            var a = e.target && typeof e.target.closest === 'function' ? e.target.closest('a[href^="#"]') : null;
            if (!a) return;
            var target = String(a.getAttribute('href') || '').trim();
            if (!target || target.charAt(0) !== '#' || target.length < 2) return;
            var ALLOWED = ['#home','#about','#values','#services','#compliance','#contact'];
            var clean = '#' + target.replace(/^[#]/, '').split('&')[0].split('?')[0];
            if (ALLOWED.indexOf(clean) === -1 && !document.querySelector(clean) && !document.getElementById(clean.slice(1))) return;
            // 触发 smoothScrollTo（包装一个类似 event 的对象）
            smoothScrollTo.call(a, {
                currentTarget: a,
                target: e.target,
                preventDefault: function () { try { e.preventDefault && e.preventDefault(); } catch (err) {} },
                stopPropagation: function () { try { e.stopPropagation && e.stopPropagation(); } catch (err) {} }
            });
        } catch (err) {}
    });

    if (contactForm) {
        contactForm.addEventListener('submit', handleFormSubmit);
    }

    var langBtns = document.querySelectorAll('#langSwitcher .lang-pill[data-lang]');
    langBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
            if (window.I18N && typeof window.I18N.switchLang === 'function') {
                window.I18N.switchLang(btn.getAttribute('data-lang'));
            }
        });
    });

    document.addEventListener('click', function (e) {
        if (
            navMenu.classList.contains('active') &&
            !e.target.closest('.nav-menu') &&
            !e.target.closest('.mobile-toggle')
        ) {
            closeMobileMenu();
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && navMenu.classList.contains('active')) {
            closeMobileMenu();
        }
    });
})();

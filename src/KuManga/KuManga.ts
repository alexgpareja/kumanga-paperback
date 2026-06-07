import {
    Chapter,
    ChapterDetails,
    ContentRating,
    HomeSection,
    HomeSectionType,
    PagedResults,
    SearchRequest,
    Source,
    SourceIntents,
    SourceManga,
    TagSection,
} from '@paperback/types'

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.kumanga.com'

export const KuMangaInfo = {
    version:        '1.0.1',
    name:           'KuManga',
    icon:           'icon.png',
    author:         'alexgpareja',
    description:    'KuManga — Manga, Manhwa y Manhua en Español',
    contentRating:  ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    language:       'es',
    intents:        SourceIntents.MANGA_CHAPTERS
                  | SourceIntents.HOMEPAGE_SECTIONS
                  | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Decodifica un string hexadecimal a texto */
function hexDecode(hex: string): string {
    const bytes = hex.match(/.{2}/g) ?? []
    return bytes.map(b => String.fromCharCode(parseInt(b, 16))).join('')
}

/**
 * Extrae las URLs de páginas del HTML del lector.
 * Las imágenes usan data-src="/img.php?src=HEX" donde HEX es
 * la URL real de databank.kumanga.com codificada en hex.
 */
function extractPageUrls($: ReturnType<typeof Application.loadCheerio>): string[] {
    const pages: string[] = []
    const seen  = new Set<string>()

    $('img.lozad, img[data-src*="img.php"]').each((_: unknown, el: unknown) => {
        const dataSrc: string = ($(el as never) as never).attr('data-src') ?? ''
        const hex = dataSrc.split('img.php?src=')[1]?.split('&')[0] ?? ''
        if (!hex) return

        const url = hexDecode(hex)
        if (url.startsWith('http') && !seen.has(url)) {
            seen.add(url)
            pages.push(url)
        }
    })

    // Fallback: buscar en el HTML raw (por si las imágenes están en inline script)
    if (pages.length === 0) {
        const html = $.html()
        for (const m of html.matchAll(/img\.php\?src=([0-9A-Fa-f]{20,})/g)) {
            const url = hexDecode(m[1]!)
            if (url.startsWith('http') && !seen.has(url)) {
                seen.add(url)
                pages.push(url)
            }
        }
    }

    return pages
}

/** Extrae el ID y slug de una URL de manga */
function parseMangaUrl(url: string): { id: string; slug: string } | null {
    const m = url.match(/\/manga\/(\d+)\/([^/?#\s]+)/)
    if (!m) return null
    return { id: m[1]!, slug: m[2]! }
}

/** ID interno: "{numericId}_{slug}" */
function buildMangaId(id: string, slug: string): string { return `${id}_${slug}` }
function getNumericId(mangaId: string): string          { return mangaId.split('_')[0] ?? mangaId }
function getSlug(mangaId: string): string               { return mangaId.split('_').slice(1).join('_') || mangaId }

function parseStatus(t: string): string {
    const l = t.toLowerCase()
    if (l.includes('activo') || l.includes('emisión') || l.includes('ongoing')) return 'Ongoing'
    if (l.includes('finaliz') || l.includes('completed') || l.includes('terminado')) return 'Completed'
    if (l.includes('inconcluso') || l.includes('abandon') || l.includes('hiatus')) return 'Hiatus'
    return 'Unknown'
}

/** Detecta si hay página siguiente parseando "Mostrando página X de Y" */
function hasNextPage($: ReturnType<typeof Application.loadCheerio>, currentPage: number): boolean {
    const text = $('body').text()
    const m = text.match(/Mostrando\s+p[áa]gina\s+(\d+)\s+de\s+(\d+)/i)
    if (m) return parseInt(m[2]!) > currentPage
    // Fallback: buscar enlace "Siguiente" o ">"
    return $('a, button').toArray().some((el: unknown) => {
        const t = $(el as never).text().trim().toLowerCase()
        return t === 'siguiente' || t === '»' || t === 'next'
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Clase principal
// ─────────────────────────────────────────────────────────────────────────────

export class KuManga extends Source {

    readonly requestManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout:    20000,
    })

    async getCloudflareBypassRequestAsync() {
        return App.createRequest({ url: BASE_URL, method: 'GET' })
    }

    // ── getMangaDetails ────────────────────────────────────────────────────

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const numId = getNumericId(mangaId)
        const slug  = getSlug(mangaId)

        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manga/${numId}/${slug}`, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        const title = $('h1').first().text().trim() || slug.replace(/-/g, ' ')

        // La portada está en og:image como static.kumanga.com/manga/{folder}/{id}.jpg
        const image = $('meta[property="og:image"]').attr('content')
            || `https://static.kumanga.com/manga/6/${numId}.jpg`

        // Descripción — está en el panel principal de texto
        const desc = $('meta[name="description"]').attr('content')
            || $('meta[property="og:description"]').attr('content')
            || $('p.lead, .col-md-8 p, [class*="sinopsis"]').first().text().trim()
            || ''

        // Estado — buscar texto "Activo", "Finalizado", "Inconcluso", "En emisión"
        const bodyText = $('body').text()
        const statusMatch = bodyText.match(/\b(Activo|Finalizado|Inconcluso|En emisión|En pausa)\b/)
        const status = statusMatch ? parseStatus(statusMatch[1]!) : 'Unknown'

        // Géneros — links de la página de detalle
        const tagItems: ReturnType<typeof App.createTag>[] = []
        const seenTags = new Set<string>()

        $('a[href*="/genero/"], a[href*="/categoria/"]').each((_: unknown, el: unknown) => {
            const href  = $(el as never).attr('href') ?? ''
            const m     = href.match(/\/(genero|categoria)\/([^/?#]+)/)
            if (!m) return
            const id    = decodeURIComponent(m[2]!).toLowerCase()
            const label = $(el as never).text().trim()
            if (!label || seenTags.has(id)) return
            seenTags.add(id)
            tagItems.push(App.createTag({ id, label }))
        })

        const tags: TagSection[] = tagItems.length
            ? [App.createTagSection({ id: 'genres', label: 'Géneros', tags: tagItems.slice(0, 20) })]
            : []

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({ image, titles: [title], desc, status, tags, hentai: false }),
        })
    }

    // ── getChapters ────────────────────────────────────────────────────────

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const numId = getNumericId(mangaId)
        const slug  = getSlug(mangaId)

        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manga/${numId}/${slug}`, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        const chapters: Chapter[] = []
        const seen = new Set<string>()

        // Links de capítulos: /manga/{mangaId}/capitulo/{chapNum}
        $('a[href*="/capitulo/"]').each((_: unknown, el: unknown) => {
            const href = $(el as never).attr('href') ?? ''
            const m    = href.match(/\/capitulo\/(\d+(?:\.\d+)?)/)
            if (!m) return

            const chapId  = m[1]!
            if (seen.has(chapId)) return
            seen.add(chapId)

            const chapNum = parseFloat(chapId)

            // Extraer fecha si está en el contenedor del capítulo
            const container = $(el as never).closest('.media-chapter, li, tr, [class*="chapter"]')
            const dateText  = container.find('time, [datetime], .date, [class*="fecha"]').attr('datetime')
                           || container.find('time, .date').text().trim()
            let time: Date | undefined
            if (dateText) {
                const d = new Date(dateText)
                if (!isNaN(d.getTime())) time = d
            }

            chapters.push(App.createChapter({
                id:       chapId,
                chapNum,
                name:     `Capítulo ${chapId}`,
                langCode: 'es',
                ...(time ? { time } : {}),
            }))
        })

        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ──────────────────────────────────────────────────
    //
    // El chapterId es el número de capítulo (ej: "3").
    // Cargamos /manga/{numId}/capitulo/{chapNum} — el servidor redirige
    // automáticamente a /manga/c/{internalChapterId} cuyo HTML contiene
    // las imágenes en img.lozad con data-src="/img.php?src=HEX".
    // Decodificamos el HEX para obtener la URL directa del CDN:
    // https://databank.kumanga.com/manga/{internalChapterId}/{page}.jpg

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const numId = getNumericId(mangaId)

        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:    `${BASE_URL}/manga/${numId}/capitulo/${chapterId}`,
                method: 'GET',
            }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')
        const pages = extractPageUrls($)

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ────────────────────────────────────────────────

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const latest  = App.createHomeSection({ id: 'latest',  title: '🔥 Últimas actualizaciones', type: HomeSectionType.singleRowNormal, containsMoreItems: true })
        const popular = App.createHomeSection({ id: 'popular', title: '📈 Populares',               type: HomeSectionType.singleRowLarge,  containsMoreItems: true })

        sectionCallback(latest)
        sectionCallback(popular)

        // Cargar la lista de manga (página 1)
        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/mangalist?page=1`, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')
        const tiles = parseMangaTiles($)

        latest.items  = tiles.slice(0, 15)
        popular.items = tiles.slice(15, 30)

        sectionCallback(latest)
        sectionCallback(popular)
    }

    async getViewMoreItems(sectionId: string, metadata: { page?: number }): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/mangalist?page=${page}`, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        return App.createPagedResults({
            results:  parseMangaTiles($),
            metadata: hasNextPage($, page) ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchResults ───────────────────────────────────────────────────
    // Búsqueda: /mangalist?keywords={query}&page={N}
    // Por género: /mangalist?genero={genreId}&page={N}

    async getSearchResults(query: SearchRequest, metadata: { page?: number }): Promise<PagedResults> {
        const page   = metadata?.page ?? 1
        const term   = (query.title ?? '').trim()
        const genres = query.includedTags?.map(t => t.id) ?? []

        const params = new URLSearchParams()
        if (term)          params.set('keywords', term)
        if (genres[0])     params.set('genero', genres[0]!)
        params.set('page', String(page))

        const url = `${BASE_URL}/mangalist?${params.toString()}`

        const resp = await this.requestManager.schedule(
            App.createRequest({ url, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        return App.createPagedResults({
            results:  parseMangaTiles($),
            metadata: hasNextPage($, page) ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchTags ──────────────────────────────────────────────────────
    // Géneros extraídos del listado real de KuManga

    async getSearchTags(): Promise<TagSection[]> {
        const genres: [string, string][] = [
            ['accion','Acción'],['artes+marciales','Artes marciales'],['aventura','Aventura'],
            ['boys+love','Boys Love'],['ciencia+ficcion','Ciencia Ficción'],['comedia','Comedia'],
            ['deportes','Deportes'],['drama','Drama'],['ecchi','Ecchi'],['fantasia','Fantasía'],
            ['gender+bender','Gender Bender'],['girls+love','Girls Love'],['gore','Gore'],
            ['harem','Harem'],['historico','Histórico'],['horror','Horror'],['isekai','Isekai'],
            ['josei','Josei'],['magia','Magia'],['misterio','Misterio'],['psicologico','Psicológico'],
            ['recuentos+de+la+vida','Recuentos de la vida'],['reencarnacion','Reencarnación'],
            ['romance','Romance'],['seinen','Seinen'],['shoujo','Shoujo'],['shounen','Shounen'],
            ['sobrenatural','Sobrenatural'],['supervivencia','Supervivencia'],['terror','Terror'],
            ['tragedia','Tragedia'],['vida+escolar','Vida escolar'],
        ]
        return [
            App.createTagSection({
                id:    'genres',
                label: 'Géneros',
                tags:  genres.map(([id, label]) => App.createTag({ id, label })),
            }),
        ]
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de tiles de manga
// ─────────────────────────────────────────────────────────────────────────────
//
// KuManga usa <li class="km-li-crd" onclick="window.open('{url}')"> para
// cada card, NO enlaces <a href>. La imagen está en <img class="km-img-crd">
// y el título en <p class="km-title-p-card">.

function parseMangaTiles($: ReturnType<never>): ReturnType<typeof App.createPartialSourceManga>[] {
    const tiles: ReturnType<typeof App.createPartialSourceManga>[] = []
    const seen  = new Set<string>()

    ;($('li.km-li-crd') as ReturnType<never>).each((_: unknown, el: unknown) => {
        // Extraer URL del atributo onclick
        const onclick = ($ as never)(el as never).attr('onclick') ?? ''
        const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)['"]\)/)
        if (!urlMatch) return

        const parsed = parseMangaUrl(urlMatch[1]!)
        if (!parsed) return

        const { id, slug } = parsed
        const mangaId = buildMangaId(id, slug)
        if (seen.has(mangaId)) return
        seen.add(mangaId)

        // Imagen y título están directamente en el HTML del card
        const imgEl = ($ as never)(el as never).find('img.km-img-crd').first()
        const image = imgEl.attr('src')
            || `https://static.kumanga.com/manga/6/${id}.jpg`

        let title = imgEl.attr('alt') ?? ''
        if (!title) title = ($ as never)(el as never).find('.km-title-p-card').first().text().trim()
        if (!title) title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

        tiles.push(App.createPartialSourceManga({ mangaId, image, title }))
    })

    return tiles
}

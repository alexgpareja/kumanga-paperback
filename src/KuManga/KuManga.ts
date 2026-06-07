import {
    Chapter,
    ChapterDetails,
    ContentRating,
    HomeSection,
    HomeSectionType,
    PagedResults,
    PartialSourceManga,
    Request,
    Response,
    SearchRequest,
    SourceManga,
    TagSection,
    HomePageSectionsProviding,
    MangaProviding,
    ChapterProviding,
    SearchResultsProviding,
} from '@paperback/types'

import * as cheerio from 'cheerio'

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.kumanga.com'

export const KuMangaInfo = {
    version: '1.0.2',
    name: 'KuManga',
    icon: 'icon.png',
    author: 'alexgpareja',
    description: 'KuManga — Manga, Manhwa y Manhua en Español',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    language: 'es',
    intents: 21, // MANGA_CHAPTERS(1) | HOMEPAGE_SECTIONS(4) | CLOUDFLARE_BYPASS_REQUIRED(16)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hexDecode(hex: string): string {
    const bytes = hex.match(/.{2}/g) ?? []
    return bytes.map(b => String.fromCharCode(parseInt(b, 16))).join('')
}

function extractPageUrls($: cheerio.CheerioAPI): string[] {
    const pages: string[] = []
    const seen = new Set<string>()

    $('img.lozad, img[data-src*="img.php"]').each((_: number, el: cheerio.Element) => {
        const dataSrc = $(el).attr('data-src') ?? ''
        const hex = dataSrc.split('img.php?src=')[1]?.split('&')[0] ?? ''
        if (!hex) return
        const url = hexDecode(hex)
        if (url.startsWith('http') && !seen.has(url)) {
            seen.add(url)
            pages.push(url)
        }
    })

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

function parseMangaUrl(url: string): { id: string; slug: string } | null {
    const m = url.match(/\/manga\/(\d+)\/([^/?#\s]+)/)
    if (!m) return null
    return { id: m[1]!, slug: m[2]! }
}

function buildMangaId(id: string, slug: string): string { return `${id}_${slug}` }
function getNumericId(mangaId: string): string { return mangaId.split('_')[0] ?? mangaId }
function getSlug(mangaId: string): string { return mangaId.split('_').slice(1).join('_') || mangaId }

function parseStatus(t: string): string {
    const l = t.toLowerCase()
    if (l.includes('activo') || l.includes('emisión') || l.includes('ongoing')) return 'Ongoing'
    if (l.includes('finaliz') || l.includes('completed') || l.includes('terminado')) return 'Completed'
    if (l.includes('inconcluso') || l.includes('abandon') || l.includes('hiatus')) return 'Hiatus'
    return 'Unknown'
}

function hasNextPage($: cheerio.CheerioAPI, currentPage: number): boolean {
    const text = $('body').text()
    const m = text.match(/Mostrando\s+p[áa]gina\s+(\d+)\s+de\s+(\d+)/i)
    if (m) return parseInt(m[2]!) > currentPage
    return $('a, button').toArray().some((el: cheerio.Element) => {
        const t = $(el).text().trim().toLowerCase()
        return t === 'siguiente' || t === '»' || t === 'next'
    })
}

function parseMangaTiles($: cheerio.CheerioAPI): PartialSourceManga[] {
    const tiles: PartialSourceManga[] = []
    const seen = new Set<string>()

    $('li.km-li-crd').each((_: number, el: cheerio.Element) => {
        const onclick = $(el).attr('onclick') ?? ''
        const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)['"]\)/)
        if (!urlMatch) return

        const parsed = parseMangaUrl(urlMatch[1]!)
        if (!parsed) return

        const { id, slug } = parsed
        const mangaId = buildMangaId(id, slug)
        if (seen.has(mangaId)) return
        seen.add(mangaId)

        const imgEl = $(el).find('img.km-img-crd').first()
        const image = imgEl.attr('src') || `https://static.kumanga.com/manga/6/${id}.jpg`

        let title = imgEl.attr('alt') ?? ''
        if (!title) title = $(el).find('.km-title-p-card').first().text().trim()
        if (!title) title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

        tiles.push(App.createPartialSourceManga({ mangaId, image, title }))
    })

    return tiles
}

// ─────────────────────────────────────────────────────────────────────────────
// Extensión — implementa interfaces directamente (patrón 0.8 correcto)
// ─────────────────────────────────────────────────────────────────────────────

export class KuManga implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding {

    // RequestManager con interceptor que añade headers correctos en CADA request
    // incluyendo el User-Agent real de Paperback — crítico para Cloudflare
    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...request.headers,
                    'user-agent': await this.requestManager.getDefaultUserAgent(),
                    'referer': `${BASE_URL}/`,
                    'origin': BASE_URL,
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    })

    // Cloudflare bypass con headers correctos
    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: BASE_URL,
            method: 'GET',
            headers: {
                'referer': `${BASE_URL}/`,
                'origin': BASE_URL,
                'user-agent': await this.requestManager.getDefaultUserAgent(),
            }
        })
    }

    // Lanza error específico en 403/503 para re-triggerear el bypass si expira
    checkResponseError(response: Response): void {
        switch (response.status) {
            case 403:
            case 503:
                throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${BASE_URL}> and press the cloud icon.`)
            case 404:
                throw new Error(`Page not found: ${response.request.url}`)
        }
    }

    // ── getMangaDetails ────────────────────────────────────────────────────

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const numId = getNumericId(mangaId)
        const slug = getSlug(mangaId)

        const response = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manga/${numId}/${slug}`, method: 'GET' }), 1
        )
        this.checkResponseError(response)
        const $ = cheerio.load(response.data as string)

        const title = $('h1').first().text().trim() || slug.replace(/-/g, ' ')
        const image = $('meta[property="og:image"]').attr('content')
            || `https://static.kumanga.com/manga/6/${numId}.jpg`
        const desc = $('meta[name="description"]').attr('content')
            || $('meta[property="og:description"]').attr('content')
            || ''

        const bodyText = $('body').text()
        const statusMatch = bodyText.match(/\b(Activo|Finalizado|Inconcluso|En emisión|En pausa)\b/)
        const status = statusMatch ? parseStatus(statusMatch[1]!) : 'Unknown'

        const tagItems: ReturnType<typeof App.createTag>[] = []
        const seenTags = new Set<string>()
        $('a[href*="/genero/"]').each((_: number, el: cheerio.Element) => {
            const href = $(el).attr('href') ?? ''
            const m = href.match(/\/genero\/([^/?#]+)/)
            if (!m) return
            const id = decodeURIComponent(m[1]!).toLowerCase()
            const label = $(el).text().trim()
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
        const slug = getSlug(mangaId)

        const response = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manga/${numId}/${slug}`, method: 'GET' }), 1
        )
        this.checkResponseError(response)
        const $ = cheerio.load(response.data as string)

        const chapters: Chapter[] = []
        const seen = new Set<string>()

        $('a[href*="/capitulo/"]').each((_: number, el: cheerio.Element) => {
            const href = $(el).attr('href') ?? ''
            const m = href.match(/\/capitulo\/(\d+(?:\.\d+)?)/)
            if (!m) return
            const chapId = m[1]!
            if (seen.has(chapId)) return
            seen.add(chapId)
            chapters.push(App.createChapter({
                id: chapId,
                chapNum: parseFloat(chapId),
                name: `Capítulo ${chapId}`,
                langCode: 'es',
            }))
        })

        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ──────────────────────────────────────────────────

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const numId = getNumericId(mangaId)
        const response = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manga/${numId}/capitulo/${chapterId}`, method: 'GET' }), 1
        )
        this.checkResponseError(response)
        const $ = cheerio.load(response.data as string)
        const pages = extractPageUrls($)
        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ────────────────────────────────────────────────

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const latest = App.createHomeSection({ id: 'latest', title: '🕒 Últimas actualizaciones', type: HomeSectionType.singleRowNormal, containsMoreItems: true })
        const popular = App.createHomeSection({ id: 'popular', title: '⭐️ Populares', type: HomeSectionType.singleRowLarge, containsMoreItems: true })

        sectionCallback(latest)
        sectionCallback(popular)

        const promises = [
            this.requestManager.schedule(App.createRequest({ url: `${BASE_URL}/mangalist?page=1`, method: 'GET' }), 1)
                .then(resp => {
                    this.checkResponseError(resp)
                    const $ = cheerio.load(resp.data as string)
                    const tiles = parseMangaTiles($)
                    latest.items = tiles.slice(0, 15)
                    popular.items = tiles.slice(15, 30)
                    sectionCallback(latest)
                    sectionCallback(popular)
                })
        ]

        await Promise.all(promises)
    }

    async getViewMoreItems(sectionId: string, metadata: { page?: number }): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const response = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/mangalist?page=${page}`, method: 'GET' }), 1
        )
        this.checkResponseError(response)
        const $ = cheerio.load(response.data as string)
        return App.createPagedResults({
            results: parseMangaTiles($),
            metadata: hasNextPage($, page) ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchResults ───────────────────────────────────────────────────

    async getSearchResults(query: SearchRequest, metadata: { page?: number }): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const term = (query.title ?? '').trim()
        const genres = query.includedTags?.map(t => t.id) ?? []

        let url = `${BASE_URL}/mangalist?page=${page}`
        if (term) url += `&keywords=${encodeURIComponent(term)}`
        if (genres[0]) url += `&genero=${encodeURIComponent(genres[0]!)}`

        const response = await this.requestManager.schedule(
            App.createRequest({ url, method: 'GET' }), 1
        )
        this.checkResponseError(response)
        const $ = cheerio.load(response.data as string)
        return App.createPagedResults({
            results: parseMangaTiles($),
            metadata: hasNextPage($, page) ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchTags ──────────────────────────────────────────────────────

    async getSearchTags(): Promise<TagSection[]> {
        const genres: [string, string][] = [
            ['accion', 'Acción'], ['artes+marciales', 'Artes marciales'], ['aventura', 'Aventura'],
            ['boys+love', 'Boys Love'], ['ciencia+ficcion', 'Ciencia Ficción'], ['comedia', 'Comedia'],
            ['deportes', 'Deportes'], ['drama', 'Drama'], ['ecchi', 'Ecchi'], ['fantasia', 'Fantasía'],
            ['gender+bender', 'Gender Bender'], ['girls+love', 'Girls Love'], ['gore', 'Gore'],
            ['harem', 'Harem'], ['historico', 'Histórico'], ['horror', 'Horror'], ['isekai', 'Isekai'],
            ['josei', 'Josei'], ['magia', 'Magia'], ['misterio', 'Misterio'], ['psicologico', 'Psicológico'],
            ['recuentos+de+la+vida', 'Recuentos de la vida'], ['reencarnacion', 'Reencarnación'],
            ['romance', 'Romance'], ['seinen', 'Seinen'], ['shoujo', 'Shoujo'], ['shounen', 'Shounen'],
            ['sobrenatural', 'Sobrenatural'], ['supervivencia', 'Supervivencia'], ['terror', 'Terror'],
            ['tragedia', 'Tragedia'], ['vida+escolar', 'Vida escolar'],
        ]
        return [App.createTagSection({
            id: 'genres',
            label: 'Géneros',
            tags: genres.map(([id, label]) => App.createTag({ id, label })),
        })]
    }
}

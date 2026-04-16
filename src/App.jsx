import React, { useState, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";
import ReactMarkdown from 'react-markdown';

// --- CONFIGURATION ---
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);

const SYSTEM_PROMPT = `You are a professional content editor. I will provide a YouTube URL.
Use the YouTube tool to extract the transcript and key visuals.
Transform the content into a high-quality blog post with the following:
1. A compelling title.
2. A 'Stoic Summary' (reflecting on the core wisdom of the content).
3. Detailed thematic sections with H3 headers.
4. A 'Bright Perspective' section (professional/therapeutic application).
Maintain a clean, sophisticated, and insightful tone. Use Markdown.`;

const BrightBlogApp = () => {
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);

  // Load history from local storage on mount
  useEffect(() => {
    const saved = JSON.parse(localStorage.getItem('bright_blog_history') || '[]');
    setHistory(saved);
  }, []);

  const generatePost = async () => {
    if (!url) return;
    setLoading(true);
    try {
      // Using Gemini 1.5 Flash for speed and high context window
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent([SYSTEM_PROMPT, `Process this video: ${url}`]);
      const response = await result.response;
      const text = response.text();

      setContent(text);

      // Update local history
      const newHistory = [{ url, text, date: new Date().toLocaleDateString() }, ...history];
      setHistory(newHistory.slice(0, 10)); // Keep last 10
      localStorage.setItem('bright_blog_history', JSON.stringify(newHistory));
    } catch (error) {
      alert("Error: Ensure your API key is valid and the YouTube add-in is accessible.");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const downloadMarkdown = () => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `blog-post-${new Date().getTime()}.md`;
    link.click();
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 md:p-12">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <header className="mb-12 border-b border-slate-200 pb-6 text-center">
          <h1 className="text-4xl font-serif font-bold text-slate-800">Bright Blog</h1>
          <p className="text-slate-500 mt-2 italic">Converting visual noise into structured wisdom.</p>
        </header>

        {/* Input Section */}
        <div className="bg-white p-6 rounded-xl shadow-sm mb-8 flex flex-col md:flex-row gap-4">
          <input
            type="text"
            placeholder="Paste YouTube Link..."
            className="flex-1 p-4 border border-slate-200 rounded-lg focus:ring-2 focus:ring-slate-400 outline-none"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            onClick={generatePost}
            disabled={loading}
            className="bg-slate-800 text-white px-8 py-4 rounded-lg font-medium hover:bg-black transition disabled:bg-slate-300"
          >
            {loading ? "Analyzing..." : "Generate Post"}
          </button>
        </div>

        {/* Main Content Area */}
        {content ? (
          <div className="space-y-6">
            <div className="flex justify-end gap-2">
              <button
                onClick={downloadMarkdown}
                className="text-sm bg-slate-200 px-4 py-2 rounded hover:bg-slate-300 transition"
              >
                Download .md for Obsidian
              </button>
            </div>
            <article className="bg-white p-8 md:p-12 rounded-xl shadow-lg prose prose-slate max-w-none">
              <ReactMarkdown>{content}</ReactMarkdown>
            </article>
          </div>
        ) : (
          <div className="text-center py-20 border-2 border-dashed border-slate-200 rounded-xl">
            <p className="text-slate-400">Your blog post will appear here.</p>
          </div>
        )}

        {/* Sidebar/History snippet */}
        {history.length > 0 && (
          <div className="mt-12">
            <h2 className="text-lg font-bold mb-4">Recent Conversions</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {history.map((item, i) => (
                <div key={i} className="p-4 bg-white rounded border border-slate-100 text-sm truncate">
                  <span className="text-slate-400 block mb-1">{item.date}</span>
                  <a href={item.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{item.url}</a>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BrightBlogApp;
